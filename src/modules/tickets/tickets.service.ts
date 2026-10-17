import type { IdOrigin, PreferentialType, Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { env } from '../../config/env.js';
import { getBrand } from '../../config/brand.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { formatCedula } from '../../lib/cedula.js';
import { businessDate, daysBetween, formatTicketCode, temporalParts, toDbDate, weekday } from '../../lib/time.js';
import { realtime } from '../../sockets/index.js';
import { citizenLookupService } from '../citizens/citizen-lookup.service.js';
import { DISPATCHABLE_WHERE, servesReason } from './queue.service.js';
import { ticketInclude, toPublicTicket, type TicketWithRelations } from './ticket.dto.js';

type Tx = Prisma.TransactionClient;

export interface CitizenInput {
  idOrigin: IdOrigin;
  idNumber: string;
  citizenName: string;
}

/**
 * Generación ATÓMICA del correlativo diario por (sede, prefijo, día).
 *
 * Un único UPSERT: PostgreSQL bloquea la fila del contador, por lo que dos
 * tótems emitiendo a la vez obtienen números distintos sin huecos ni
 * duplicados. Al cambiar el día se crea una fila nueva → reinicia en 001.
 * Los motivos que comparten prefijo comparten numeración (N-001, N-002…).
 */
async function nextTicketNumber(tx: Tx, branchId: string, prefix: string, serviceDate: string): Promise<number> {
  const [row] = await tx.$queryRaw<{ last_number: number }[]>`
    INSERT INTO daily_counters (branch_id, prefix, service_date, last_number)
    VALUES (${branchId}::uuid, ${prefix}, ${serviceDate}::date, 1)
    ON CONFLICT (branch_id, prefix, service_date)
    DO UPDATE SET last_number = daily_counters.last_number + 1
    RETURNING last_number`;
  return row.last_number;
}

/**
 * Dependencia elegida en el tótem (Zona Educativa, Atención al Ciudadano…).
 * Si la sede tiene dependencias activas es obligatoria; si no tiene, se ignora.
 * Su prefijo define el código del turno: ZE-001, OAC-001.
 */
async function resolveDependency(tx: Tx | typeof prisma, branchId: string, dependencyId?: string | null) {
  if (dependencyId) {
    const dep = await tx.dependency.findFirst({ where: { id: dependencyId, branchId, isActive: true } });
    if (!dep) throw notFound('Dependencia no disponible en esta sede');
    return dep;
  }
  if (await tx.dependency.count({ where: { branchId, isActive: true } })) {
    throw badRequest('Seleccione la dependencia de atención (Zona Educativa o Atención al Ciudadano)');
  }
  return null;
}

async function getActiveReason(tx: Tx | typeof prisma, branchId: string, reasonId: string) {
  const reason = await tx.attentionReason.findFirst({
    where: { id: reasonId, branchId, isActive: true, branch: { isActive: true } },
  });
  if (!reason) throw notFound('Motivo de atención no disponible en esta sede');
  return reason;
}

/** Serializa operaciones del MISMO ciudadano (doble toque en el tótem) dentro de la transacción. */
const lockCitizen = (tx: Tx, c: Pick<CitizenInput, 'idOrigin' | 'idNumber'>) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`citizen|${c.idOrigin}|${c.idNumber}`}))`;

const priorityFor = (reasonPriority: number, preferential?: PreferentialType | null) =>
  reasonPriority + (preferential ? getBrand().attention.preferentialBoost : 0);

/** Posición del turno dentro de su motivo (cuántos despachables tiene delante). */
export async function queuePosition(t: TicketWithRelations): Promise<number | null> {
  if (t.status !== 'WAITING') return null;
  if (t.type === 'SCHEDULED' && !t.checkedInAt) return null;
  const ahead = await prisma.ticket.count({
    where: {
      branchId: t.branchId,
      reasonId: t.reasonId,
      dependencyId: t.dependencyId,
      serviceDate: t.serviceDate,
      status: 'WAITING',
      ...DISPATCHABLE_WHERE,
      AND: [
        {
          OR: [
            { priorityLevel: { gt: t.priorityLevel } },
            { priorityLevel: t.priorityLevel, createdAt: { lt: t.createdAt } },
          ],
        },
      ],
    },
  });
  return ahead + 1;
}

async function withPosition(t: TicketWithRelations) {
  const position = await queuePosition(t);
  const [reason, openDesks] = await Promise.all([
    prisma.attentionReason.findUnique({ where: { id: t.reasonId }, select: { estimatedDurationMin: true } }),
    prisma.desk.count({
      where: { branchId: t.branchId, isActive: true, currentOperatorId: { not: null }, ...servesReason(t.reasonId, t.dependencyId) },
    }),
  ]);
  return {
    ...toPublicTicket(t),
    position,
    estimatedWaitMin:
      position && reason ? Math.ceil(((position - 1) * reason.estimatedDurationMin) / Math.max(1, openDesks)) : null,
  };
}

// ── Turnos presenciales (tótem) ────────────────────────────────

export async function issueWalkInTicket(
  input: CitizenInput & {
    branchId: string;
    reasonId: string;
    dependencyId?: string | null;
    preferentialType?: PreferentialType | null;
  },
) {
  const day = businessDate();
  const now = new Date();

  const ticket = await prisma.$transaction(async (tx) => {
    const reason = await getActiveReason(tx, input.branchId, input.reasonId);
    const dependency = await resolveDependency(tx, input.branchId, input.dependencyId);
    await lockCitizen(tx, input);

    // Un ciudadano no puede tener dos turnos activos el mismo día en la misma sede
    const active = await tx.ticket.findFirst({
      where: {
        branchId: input.branchId,
        serviceDate: toDbDate(day),
        idOrigin: input.idOrigin,
        idNumber: input.idNumber,
        status: { in: ['WAITING', 'CALLED', 'IN_SERVICE'] },
      },
      include: { reason: { select: { name: true } } },
    });
    if (active?.type === 'SCHEDULED' && !active.checkedInAt) {
      throw conflict(`Tiene una cita hoy (${active.code}). Use la opción "Tengo cita" para registrar su llegada.`, 'HAS_APPOINTMENT');
    }
    if (active) {
      throw conflict(`La cédula ${formatCedula(input.idOrigin, input.idNumber)} ya tiene el turno ${active.code} (${active.reason.name}) en curso.`, 'ALREADY_IN_QUEUE');
    }

    const prefix = dependency?.prefix ?? reason.prefixLetter;
    const n = await nextTicketNumber(tx, input.branchId, prefix, day);
    await citizenLookupService.remember(input.idOrigin, input.idNumber, input.citizenName, tx);

    return tx.ticket.create({
      data: {
        branchId: input.branchId,
        reasonId: reason.id,
        dependencyId: dependency?.id ?? null,
        ticketNumber: n,
        code: formatTicketCode(prefix, n),
        type: 'WALK_IN',
        idOrigin: input.idOrigin,
        idNumber: input.idNumber,
        citizenName: input.citizenName,
        preferentialType: input.preferentialType ?? null,
        priorityLevel: priorityFor(reason.priorityLevel, input.preferentialType),
        serviceDate: toDbDate(day),
        createdAt: now,
        ...temporalParts(now),
      },
      include: ticketInclude,
    });
  });

  realtime.queueUpdated(ticket.branchId);
  return withPosition(ticket);
}

export async function getTicketStatus(ticketId: string) {
  const ticket = await prisma.ticket.findUnique({ where: { id: ticketId }, include: ticketInclude });
  if (!ticket) throw notFound('Turno no encontrado');
  return withPosition(ticket);
}

/** El ciudadano cancela su turno (sólo mientras está en espera). */
export async function cancelTicket(ticketId: string) {
  const res = await prisma.ticket.updateMany({
    where: { id: ticketId, status: 'WAITING' },
    data: { status: 'CANCELLED', finishedAt: new Date() },
  });
  if (res.count === 0) throw conflict('El turno ya no puede cancelarse');
  const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId }, include: ticketInclude });
  realtime.ticketUpdated(toPublicTicket(ticket));
  realtime.queueUpdated(ticket.branchId);
  return toPublicTicket(ticket);
}

// ── Citas previas (web) ────────────────────────────────────────

/** Cantidad de taquillas que atienden el motivo y la dependencia (= citas simultáneas por franja). */
async function slotCapacity(tx: Tx | typeof prisma, branchId: string, reasonId: string, dependencyId: string | null) {
  const desks = await tx.desk.count({ where: { branchId, isActive: true, ...servesReason(reasonId, dependencyId) } });
  return Math.max(1, desks);
}

interface SlotRow {
  slot_start: Date;
  label: string;
  booked: number;
}

/**
 * Las franjas se generan en PostgreSQL (generate_series + AT TIME ZONE), así
 * '2026-10-19 09:00' en APP_TIMEZONE se convierte al instante UTC correcto.
 */
async function querySlots(tx: Tx | typeof prisma, reasonId: string, dependencyId: string | null, date: string): Promise<SlotRow[]> {
  const { openingTime, closingTime, slotMinutes } = getBrand().appointments;
  return tx.$queryRaw<SlotRow[]>`
    WITH slots AS (
      SELECT gs AS slot_start
      FROM generate_series(
        (${date}::date + ${openingTime}::time) AT TIME ZONE ${env.APP_TIMEZONE},
        (${date}::date + ${closingTime}::time) AT TIME ZONE ${env.APP_TIMEZONE} - make_interval(mins => ${slotMinutes}::int),
        make_interval(mins => ${slotMinutes}::int)
      ) AS gs
    )
    SELECT s.slot_start,
           to_char(s.slot_start AT TIME ZONE ${env.APP_TIMEZONE}, 'HH24:MI') AS label,
           (SELECT count(*)::int FROM tickets t
             WHERE t.reason_id = ${reasonId}::uuid
               AND t.dependency_id IS NOT DISTINCT FROM ${dependencyId}::uuid
               AND t.type = 'SCHEDULED'
               AND t.status <> 'CANCELLED'
               AND t.scheduled_at = s.slot_start) AS booked
    FROM slots s
    ORDER BY s.slot_start`;
}

function assertBookableDate(date: string) {
  const { workingDays, maxDaysAhead } = getBrand().appointments;
  const diff = daysBetween(businessDate(), date);
  if (diff < 0) throw badRequest('La fecha ya pasó');
  if (diff > maxDaysAhead) throw badRequest(`Sólo se puede agendar hasta ${maxDaysAhead} días hacia adelante`);
  if (!workingDays.includes(weekday(date))) throw badRequest('La oficina no atiende ese día');
}

export async function getAvailability(input: { branchId: string; reasonId: string; dependencyId?: string; date: string }) {
  assertBookableDate(input.date);
  const reason = await getActiveReason(prisma, input.branchId, input.reasonId);
  if (!reason.allowAppointments) throw badRequest('Este trámite no admite citas previas');
  const dependency = await resolveDependency(prisma, input.branchId, input.dependencyId);
  const depId = dependency?.id ?? null;

  const [capacity, rows] = await Promise.all([
    slotCapacity(prisma, input.branchId, reason.id, depId),
    querySlots(prisma, reason.id, depId, input.date),
  ]);
  const now = Date.now();
  return {
    date: input.date,
    capacity,
    slots: rows.map((r) => ({
      time: r.label,
      startsAt: r.slot_start,
      available: r.slot_start.getTime() > now ? Math.max(0, capacity - r.booked) : 0,
    })),
  };
}

export async function bookAppointment(
  input: CitizenInput & {
    branchId: string;
    reasonId: string;
    dependencyId?: string | null;
    date: string;
    time: string;
    preferentialType?: PreferentialType | null;
  },
) {
  assertBookableDate(input.date);

  const ticket = await prisma.$transaction(async (tx) => {
    const reason = await getActiveReason(tx, input.branchId, input.reasonId);
    if (!reason.allowAppointments) throw badRequest('Este trámite no admite citas previas');
    const dependency = await resolveDependency(tx, input.branchId, input.dependencyId);
    const depId = dependency?.id ?? null;

    await lockCitizen(tx, input);
    // Serializa reservas concurrentes de la MISMA franja, motivo y dependencia (lock liberado al hacer COMMIT).
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${reason.id}|${depId}|${input.date}|${input.time}`}))`;

    const slot = (await querySlots(tx, reason.id, depId, input.date)).find((s) => s.label === input.time);
    if (!slot) throw badRequest('Horario fuera de la grilla de atención');
    if (slot.slot_start.getTime() <= Date.now()) throw badRequest('Ese horario ya pasó');
    if (slot.booked >= (await slotCapacity(tx, input.branchId, reason.id, depId))) {
      throw conflict('Ese horario se acaba de ocupar, elija otro', 'SLOT_FULL');
    }

    const duplicate = await tx.ticket.findFirst({
      where: {
        branchId: input.branchId,
        serviceDate: toDbDate(input.date),
        idOrigin: input.idOrigin,
        idNumber: input.idNumber,
        type: 'SCHEDULED',
        status: { in: ['WAITING', 'CALLED', 'IN_SERVICE'] },
      },
    });
    if (duplicate) throw conflict(`Ya tiene una cita para ese día (${duplicate.code})`, 'DUPLICATE_APPOINTMENT');

    const prefix = dependency?.prefix ?? reason.prefixLetter;
    const n = await nextTicketNumber(tx, input.branchId, prefix, input.date);
    await citizenLookupService.remember(input.idOrigin, input.idNumber, input.citizenName, tx);

    return tx.ticket.create({
      data: {
        branchId: input.branchId,
        reasonId: reason.id,
        dependencyId: depId,
        ticketNumber: n,
        code: formatTicketCode(prefix, n),
        type: 'SCHEDULED',
        scheduledAt: slot.slot_start,
        idOrigin: input.idOrigin,
        idNumber: input.idNumber,
        citizenName: input.citizenName,
        preferentialType: input.preferentialType ?? null,
        priorityLevel: priorityFor(reason.priorityLevel, input.preferentialType),
        serviceDate: toDbDate(input.date),
        // El desglose de una cita refleja el momento agendado de la atención
        ...temporalParts(slot.slot_start),
      },
      include: ticketInclude,
    });
  });

  realtime.queueUpdated(ticket.branchId);
  return toPublicTicket(ticket);
}

/**
 * Check-in en el tótem: la cita de hoy pasa a ser despachable.
 * Se permite desde `checkInEarlyMinutes` antes del horario agendado.
 */
export async function checkInAppointment(input: { branchId: string; idOrigin: IdOrigin; idNumber: string }) {
  const { checkInEarlyMinutes } = getBrand().appointments;
  const appt = await prisma.ticket.findFirst({
    where: {
      branchId: input.branchId,
      serviceDate: toDbDate(businessDate()),
      idOrigin: input.idOrigin,
      idNumber: input.idNumber,
      type: 'SCHEDULED',
      status: 'WAITING',
      checkedInAt: null,
    },
    orderBy: { scheduledAt: 'asc' },
  });
  if (!appt) throw notFound('No encontramos una cita para hoy con esa cédula');

  const earliest = appt.scheduledAt!.getTime() - checkInEarlyMinutes * 60_000;
  if (Date.now() < earliest) {
    const time = appt.scheduledAt!.toLocaleTimeString(getBrand().locale, {
      timeZone: env.APP_TIMEZONE,
      hour: '2-digit',
      minute: '2-digit',
    });
    throw badRequest(`Su cita es a las ${time}. Puede registrar su llegada desde ${checkInEarlyMinutes} minutos antes.`);
  }

  const res = await prisma.ticket.updateMany({
    where: { id: appt.id, checkedInAt: null, status: 'WAITING' },
    data: { checkedInAt: new Date() },
  });
  if (res.count === 0) throw conflict('La cita ya fue registrada');

  const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: appt.id }, include: ticketInclude });
  realtime.queueUpdated(ticket.branchId);
  return withPosition(ticket);
}

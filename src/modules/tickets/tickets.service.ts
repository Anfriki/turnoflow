import { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { env } from '../../config/env.js';
import { getBrand } from '../../config/brand.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { businessDate, daysBetween, formatTicketCode, toDbDate, weekday } from '../../lib/time.js';
import { realtime } from '../../sockets/index.js';
import { DISPATCHABLE_WHERE } from './queue.service.js';
import { ticketInclude, toPublicTicket, type TicketWithRelations } from './ticket.dto.js';

type Tx = Prisma.TransactionClient;

/**
 * Generación ATÓMICA del correlativo diario.
 *
 * Un único UPSERT sobre daily_counters (PK = categoría + día): PostgreSQL toma
 * un lock de fila, por lo que dos tótems emitiendo a la vez obtienen números
 * distintos sin huecos ni duplicados. Al cambiar el día de negocio se crea una
 * fila nueva → la numeración "se reinicia" sola en 001.
 */
async function nextTicketNumber(tx: Tx, categoryId: string, serviceDate: string): Promise<number> {
  const [row] = await tx.$queryRaw<{ last_number: number }[]>`
    INSERT INTO daily_counters (category_id, service_date, last_number)
    VALUES (${categoryId}::uuid, ${serviceDate}::date, 1)
    ON CONFLICT (category_id, service_date)
    DO UPDATE SET last_number = daily_counters.last_number + 1
    RETURNING last_number`;
  return row.last_number;
}

async function getActiveCategory(tx: Tx, branchId: string, categoryId: string) {
  const category = await tx.serviceCategory.findFirst({
    where: { id: categoryId, branchId, isActive: true, branch: { isActive: true } },
  });
  if (!category) throw notFound('Trámite no disponible en esta sucursal');
  return category;
}

/** Posición del turno dentro de su cola (cuántos despachables tiene delante). */
export async function queuePosition(t: TicketWithRelations): Promise<number | null> {
  if (t.status !== 'WAITING') return null;
  if (t.type === 'SCHEDULED' && !t.checkedInAt) return null;
  const ahead = await prisma.ticket.count({
    where: {
      branchId: t.branchId,
      categoryId: t.categoryId,
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
  const est = await prisma.serviceCategory.findUnique({
    where: { id: t.categoryId },
    select: { estimatedDurationMin: true },
  });
  const openDesks = await prisma.desk.count({
    where: {
      branchId: t.branchId,
      isActive: true,
      currentOperatorId: { not: null },
      OR: [{ categories: { none: {} } }, { categories: { some: { categoryId: t.categoryId } } }],
    },
  });
  return {
    ...toPublicTicket(t),
    position,
    estimatedWaitMin:
      position && est ? Math.ceil(((position - 1) * est.estimatedDurationMin) / Math.max(1, openDesks)) : null,
  };
}

// ── Turnos presenciales (tótem) ────────────────────────────────

export async function issueWalkInTicket(input: {
  branchId: string;
  categoryId: string;
  customerIdentifier?: string;
}) {
  const day = businessDate();
  const ticket = await prisma.$transaction(async (tx) => {
    const category = await getActiveCategory(tx, input.branchId, input.categoryId);
    const n = await nextTicketNumber(tx, category.id, day);
    return tx.ticket.create({
      data: {
        branchId: input.branchId,
        categoryId: category.id,
        ticketNumber: n,
        code: formatTicketCode(category.prefixLetter, n),
        customerIdentifier: input.customerIdentifier || null,
        type: 'WALK_IN',
        priorityLevel: category.priorityLevel,
        serviceDate: toDbDate(day),
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

/** El cliente cancela su turno (sólo mientras está en espera). */
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

/** Cantidad de boxes que atienden la categoría (= citas simultáneas por franja). */
async function slotCapacity(tx: Tx | typeof prisma, branchId: string, categoryId: string) {
  const desks = await tx.desk.count({
    where: {
      branchId,
      isActive: true,
      OR: [{ categories: { none: {} } }, { categories: { some: { categoryId } } }],
    },
  });
  return Math.max(1, desks);
}

interface SlotRow {
  slot_start: Date;
  label: string;
  booked: number;
}

/**
 * Las franjas se generan en PostgreSQL (generate_series + AT TIME ZONE), así
 * '2026-10-16 09:00' en APP_TIMEZONE se convierte al instante UTC correcto,
 * incluso en días con cambio de horario.
 */
async function querySlots(tx: Tx | typeof prisma, categoryId: string, date: string): Promise<SlotRow[]> {
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
             WHERE t.category_id = ${categoryId}::uuid
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
  if (!workingDays.includes(weekday(date))) throw badRequest('La sucursal no atiende ese día');
}

export async function getAvailability(input: { branchId: string; categoryId: string; date: string }) {
  assertBookableDate(input.date);
  const category = await getActiveCategory(prisma, input.branchId, input.categoryId);
  if (!category.allowAppointments) throw badRequest('Este trámite no admite citas previas');

  const [capacity, rows] = await Promise.all([
    slotCapacity(prisma, input.branchId, category.id),
    querySlots(prisma, category.id, input.date),
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

export async function bookAppointment(input: {
  branchId: string;
  categoryId: string;
  customerIdentifier: string;
  date: string;
  time: string;
}) {
  assertBookableDate(input.date);

  const ticket = await prisma.$transaction(async (tx) => {
    const category = await getActiveCategory(tx, input.branchId, input.categoryId);
    if (!category.allowAppointments) throw badRequest('Este trámite no admite citas previas');

    // Serializa reservas concurrentes de la MISMA franja y categoría (lock liberado al hacer COMMIT).
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${category.id}|${input.date}|${input.time}`}))`;

    const slot = (await querySlots(tx, category.id, input.date)).find((s) => s.label === input.time);
    if (!slot) throw badRequest('Horario fuera de la grilla de atención');
    if (slot.slot_start.getTime() <= Date.now()) throw badRequest('Ese horario ya pasó');
    if (slot.booked >= (await slotCapacity(tx, input.branchId, category.id))) {
      throw conflict('Ese horario se acaba de ocupar, elegí otro', 'SLOT_FULL');
    }

    const duplicate = await tx.ticket.findFirst({
      where: {
        categoryId: category.id,
        serviceDate: toDbDate(input.date),
        customerIdentifier: input.customerIdentifier,
        type: 'SCHEDULED',
        status: { in: ['WAITING', 'CALLED', 'IN_SERVICE'] },
      },
    });
    if (duplicate) throw conflict(`Ya tenés una cita para ese día (${duplicate.code})`, 'DUPLICATE_APPOINTMENT');

    const n = await nextTicketNumber(tx, category.id, input.date);
    return tx.ticket.create({
      data: {
        branchId: input.branchId,
        categoryId: category.id,
        ticketNumber: n,
        code: formatTicketCode(category.prefixLetter, n),
        customerIdentifier: input.customerIdentifier,
        type: 'SCHEDULED',
        scheduledAt: slot.slot_start,
        priorityLevel: category.priorityLevel,
        serviceDate: toDbDate(input.date),
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
export async function checkInAppointment(input: { branchId: string; customerIdentifier: string }) {
  const { checkInEarlyMinutes } = getBrand().appointments;
  const appt = await prisma.ticket.findFirst({
    where: {
      branchId: input.branchId,
      serviceDate: toDbDate(businessDate()),
      customerIdentifier: input.customerIdentifier,
      type: 'SCHEDULED',
      status: 'WAITING',
      checkedInAt: null,
    },
    orderBy: { scheduledAt: 'asc' },
  });
  if (!appt) throw notFound('No encontramos una cita para hoy con ese dato');

  const earliest = appt.scheduledAt!.getTime() - checkInEarlyMinutes * 60_000;
  if (Date.now() < earliest) {
    const time = appt.scheduledAt!.toLocaleTimeString(getBrand().locale, {
      timeZone: env.APP_TIMEZONE,
      hour: '2-digit',
      minute: '2-digit',
    });
    throw badRequest(`Tu cita es a las ${time}. Podés presentarte desde ${checkInEarlyMinutes} minutos antes.`);
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

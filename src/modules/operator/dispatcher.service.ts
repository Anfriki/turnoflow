import { Prisma, type ResolutionStatus, type TicketStatus } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import { businessDate, secondsBetween, toDbDate } from '../../lib/time.js';
import { assertBranchAccess, type AuthUser } from '../../middleware/auth.js';
import { realtime } from '../../sockets/index.js';
import { ticketInclude, toPublicTicket, toStaffTicket, type TicketWithRelations } from '../tickets/ticket.dto.js';

/**
 * ─────────────────────────────────────────────────────────────
 *  DESPACHO DE TURNOS — "Llamar siguiente"
 *
 *  Garantía: dos taquillas que presionan "Llamar siguiente" en el mismo
 *  milisegundo NUNCA reciben el mismo ciudadano.
 *
 *  1. `SELECT … FROM desks … FOR UPDATE`  → serializa clics repetidos de la
 *     MISMA taquilla (doble clic, dos pestañas abiertas).
 *  2. `SELECT … FROM tickets … FOR UPDATE SKIP LOCKED` → entre taquillas
 *     DISTINTAS, cada transacción bloquea su candidato y las demás lo saltean
 *     en lugar de esperar: sin colisiones y sin colas de bloqueo.
 *  3. UPDATE a CALLED (con instantánea de taquilla y funcionario) dentro de la
 *     misma transacción → COMMIT → emisión socket.
 *  4. Red de seguridad en la BD: índice único parcial `uq_tickets_desk_active`
 *     impide que una taquilla tenga dos turnos activos simultáneos.
 * ─────────────────────────────────────────────────────────────
 */

const ACTIVE: TicketStatus[] = ['CALLED', 'IN_SERVICE'];

interface DeskRow {
  id: string;
  branch_id: string;
  number: number;
  current_operator_id: string | null;
}

async function lockOwnedDesk(tx: Prisma.TransactionClient, deskId: string, user: AuthUser) {
  const [desk] = await tx.$queryRaw<DeskRow[]>`
    SELECT id, branch_id, number, current_operator_id
    FROM desks
    WHERE id = ${deskId}::uuid AND is_active
    FOR UPDATE`;
  if (!desk) throw notFound('Taquilla no encontrada');
  if (desk.current_operator_id !== user.sub) throw forbidden('Primero tome esta taquilla para operar');
  return desk;
}

export async function callNext(deskId: string, user: AuthUser) {
  const ticket = await prisma.$transaction(
    async (tx) => {
      const desk = await lockOwnedDesk(tx, deskId, user);

      const active = await tx.ticket.findFirst({ where: { deskId, status: { in: ACTIVE } } });
      if (active) throw conflict(`La taquilla ya tiene el turno ${active.code} en curso. Finalícelo antes de llamar otro.`, 'DESK_BUSY');

      // El corazón del despacho: prioridad DESC, antigüedad ASC, saltando filas bloqueadas.
      // Usa idx_tickets_dispatch (branch_id, status, priority_level DESC, created_at ASC).
      const [next] = await tx.$queryRaw<{ id: string; created_at: Date; checked_in_at: Date | null }[]>`
        SELECT t.id, t.created_at, t.checked_in_at
        FROM tickets t
        WHERE t.branch_id = ${desk.branch_id}::uuid
          AND t.status = 'WAITING'
          AND t.service_date = ${businessDate()}::date
          AND (t.type = 'WALK_IN' OR t.checked_in_at IS NOT NULL)
          AND (
            NOT EXISTS (SELECT 1 FROM desk_reasons dr WHERE dr.desk_id = ${deskId}::uuid)
            OR t.reason_id IN (SELECT dr.reason_id FROM desk_reasons dr WHERE dr.desk_id = ${deskId}::uuid)
          )
        ORDER BY t.priority_level DESC, t.created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED`;

      if (!next) return null;

      const operator = await tx.user.findUniqueOrThrow({ where: { id: user.sub }, select: { name: true } });
      const now = new Date();
      return tx.ticket.update({
        where: { id: next.id },
        data: {
          status: 'CALLED',
          deskId,
          deskNumber: desk.number,
          operatorId: user.sub,
          operatorName: operator.name,
          calledAt: now,
          waitSeconds: secondsBetween(next.checked_in_at ?? next.created_at, now),
        },
        include: ticketInclude,
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 10_000 },
  );

  if (!ticket) return null;

  // Sólo después del COMMIT se avisa a la sala: nunca se anuncia un turno que luego hace rollback.
  realtime.ticketCalled(toPublicTicket(ticket));
  realtime.queueUpdated(ticket.branchId);
  return toStaffTicket(ticket);
}

/** Carga un ticket y verifica que el usuario opere la taquilla a la que fue asignado. */
async function loadTicketForDesk(ticketId: string, user: AuthUser) {
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    include: { ...ticketInclude, desk: { select: { id: true, identifier: true, number: true, currentOperatorId: true } } },
  });
  if (!ticket || !ticket.deskId) throw notFound('Turno no encontrado o no asignado a una taquilla');
  const isOwner = ticket.desk?.currentOperatorId === user.sub;
  const isSupervisor = user.role !== 'OPERATOR';
  if (!isOwner && !isSupervisor) throw forbidden('Este turno pertenece a otra taquilla');
  if (isSupervisor) assertBranchAccess(user, ticket.branchId);
  return ticket;
}

/**
 * Transición de estado optimista: el UPDATE sólo aplica si el ticket sigue en
 * alguno de los estados de origen. Si otro proceso lo cambió, count = 0 → 409.
 */
async function transition(
  ticketId: string,
  user: AuthUser,
  from: TicketStatus[],
  data: Prisma.TicketUncheckedUpdateManyInput | ((current: TicketWithRelations) => Prisma.TicketUncheckedUpdateManyInput),
) {
  const current = await loadTicketForDesk(ticketId, user);
  if (!from.includes(current.status)) {
    throw conflict(`Acción inválida: el turno está en estado ${current.status}`, 'INVALID_TRANSITION');
  }
  const res = await prisma.ticket.updateMany({
    where: { id: ticketId, deskId: current.deskId, status: { in: from } },
    data: typeof data === 'function' ? data(current) : data,
  });
  if (res.count === 0) throw conflict('El turno cambió de estado mientras operaba. Actualice la pantalla.', 'INVALID_TRANSITION');

  const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId }, include: ticketInclude });
  realtime.ticketUpdated(toPublicTicket(ticket));
  realtime.queueUpdated(ticket.branchId);
  return ticket;
}

/** CALLED → IN_SERVICE: el ciudadano llegó a la taquilla. */
export async function startService(ticketId: string, user: AuthUser) {
  return toStaffTicket(await transition(ticketId, user, ['CALLED'], { status: 'IN_SERVICE', startedAt: new Date() }));
}

export interface ResolutionInput {
  resolutionStatus: ResolutionStatus;
  resolutionNotes: string;
  destinationDepartment?: string | null;
}

/**
 * IN_SERVICE (o CALLED) → ATTENDED con el RESULTADO DE LA PETICIÓN.
 * La validación de campos obligatorios (observaciones, destino si REMITIDO)
 * se hace en la ruta con Zod y además la refuerza un CHECK en la BD.
 */
export async function finishService(ticketId: string, user: AuthUser, resolution: ResolutionInput) {
  const now = new Date();
  return toStaffTicket(
    await transition(ticketId, user, ['CALLED', 'IN_SERVICE'], (current) => {
      const startedAt = current.startedAt ?? now;
      return {
        status: 'ATTENDED',
        startedAt,
        finishedAt: now,
        serviceSeconds: secondsBetween(startedAt, now),
        resolutionStatus: resolution.resolutionStatus,
        resolutionNotes: resolution.resolutionNotes,
        destinationDepartment: resolution.resolutionStatus === 'REMITIDO' ? resolution.destinationDepartment : null,
      };
    }),
  );
}

/** CALLED → ABSENT: el ciudadano no se presentó. */
export async function markAbsent(ticketId: string, user: AuthUser) {
  return toStaffTicket(await transition(ticketId, user, ['CALLED'], { status: 'ABSENT', finishedAt: new Date() }));
}

/** Vuelve a anunciar en la TV un turno ya llamado. */
export async function recall(ticketId: string, user: AuthUser) {
  const ticket = await transition(ticketId, user, ['CALLED'], { recallCount: { increment: 1 }, calledAt: new Date() });
  realtime.ticketCalled(toPublicTicket(ticket), true);
  return toStaffTicket(ticket);
}

/** Devuelve un ticket llamado a la cola (p. ej. el funcionario se equivocó de taquilla). */
export async function returnToQueue(ticketId: string, user: AuthUser) {
  return toStaffTicket(
    await transition(ticketId, user, ['CALLED'], {
      status: 'WAITING',
      deskId: null,
      deskNumber: null,
      operatorId: null,
      operatorName: null,
      calledAt: null,
      waitSeconds: null,
    }),
  );
}

// ── Gestión de taquillas ──────────────────────────────────────

export async function claimDesk(deskId: string, user: AuthUser) {
  const desk = await prisma.$transaction(async (tx) => {
    const desk = await tx.desk.findFirst({ where: { id: deskId, isActive: true } });
    if (!desk) throw notFound('Taquilla no encontrada');
    assertBranchAccess(user, desk.branchId);

    // Un funcionario ocupa una única taquilla: libera cualquier otra que tuviera tomada.
    await tx.desk.updateMany({
      where: { currentOperatorId: user.sub, id: { not: deskId } },
      data: { currentOperatorId: null },
    });
    const res = await tx.desk.updateMany({
      where: { id: deskId, OR: [{ currentOperatorId: null }, { currentOperatorId: user.sub }] },
      data: { currentOperatorId: user.sub },
    });
    if (res.count === 0) throw conflict('La taquilla ya está ocupada por otro funcionario', 'DESK_TAKEN');
    return desk;
  });
  realtime.queueUpdated(desk.branchId);
  return { id: desk.id, number: desk.number, identifier: desk.identifier, branchId: desk.branchId };
}

export async function releaseDesk(deskId: string, user: AuthUser, force = false) {
  const desk = await prisma.desk.findUnique({ where: { id: deskId } });
  if (!desk) throw notFound('Taquilla no encontrada');
  assertBranchAccess(user, desk.branchId);
  if (desk.currentOperatorId !== user.sub && !(force && user.role !== 'OPERATOR')) {
    throw forbidden('Sólo el funcionario de la taquilla o un supervisor pueden liberarla');
  }
  const active = await prisma.ticket.findFirst({ where: { deskId, status: { in: ACTIVE } } });
  if (active && !force) throw conflict(`Finalice el turno ${active.code} antes de liberar la taquilla`, 'DESK_BUSY');

  await prisma.desk.update({ where: { id: deskId }, data: { currentOperatorId: null } });
  realtime.queueUpdated(desk.branchId);
  return { ok: true };
}

/** Turno activo de la taquilla + atendidos hoy por el funcionario. */
export async function getDeskState(deskId: string, user: AuthUser) {
  const desk = await prisma.desk.findUnique({
    where: { id: deskId },
    include: {
      reasons: { include: { reason: { select: { id: true, code: true, name: true } } } },
      currentOperator: { select: { name: true } },
    },
  });
  if (!desk) throw notFound('Taquilla no encontrada');
  assertBranchAccess(user, desk.branchId);

  const [current, attendedToday] = await Promise.all([
    prisma.ticket.findFirst({ where: { deskId, status: { in: ACTIVE } }, include: ticketInclude }),
    prisma.ticket.count({
      where: { deskId, operatorId: user.sub, status: 'ATTENDED', serviceDate: toDbDate(businessDate()) },
    }),
  ]);
  return {
    desk: {
      id: desk.id,
      number: desk.number,
      identifier: desk.identifier,
      branchId: desk.branchId,
      isMine: desk.currentOperatorId === user.sub,
      operatorName: desk.currentOperator?.name ?? null,
      reasons: desk.reasons.map((r) => ({ id: r.reason.id, code: r.reason.code, name: r.reason.name })),
    },
    current: current ? toStaffTicket(current) : null,
    attendedToday,
  };
}

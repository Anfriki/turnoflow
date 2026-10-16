import { Prisma, type TicketStatus } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import { businessDate, toDbDate } from '../../lib/time.js';
import { assertBranchAccess, type AuthUser } from '../../middleware/auth.js';
import { realtime } from '../../sockets/index.js';
import { ticketInclude, toPublicTicket, toStaffTicket } from '../tickets/ticket.dto.js';

/**
 * ─────────────────────────────────────────────────────────────
 *  DESPACHO DE TURNOS — "Llamar siguiente"
 *
 *  Garantía: dos operadores que presionan "Llamar siguiente" en el mismo
 *  milisegundo NUNCA reciben el mismo ticket.
 *
 *  1. `SELECT … FROM desks … FOR UPDATE`  → serializa clics repetidos del
 *     MISMO box (doble clic, dos pestañas abiertas).
 *  2. `SELECT … FROM tickets … FOR UPDATE SKIP LOCKED` → entre boxes
 *     DISTINTOS, cada transacción bloquea su candidato y las demás lo saltean
 *     en lugar de esperar: sin colisiones y sin colas de bloqueo.
 *  3. UPDATE a CALLED dentro de la misma transacción → COMMIT → emisión socket.
 *  4. Red de seguridad en la BD: índice único parcial `uq_tickets_desk_active`
 *     impide que un box tenga dos turnos activos simultáneos.
 * ─────────────────────────────────────────────────────────────
 */

const ACTIVE: TicketStatus[] = ['CALLED', 'IN_SERVICE'];

interface DeskRow {
  id: string;
  branch_id: string;
  current_operator_id: string | null;
}

async function lockOwnedDesk(tx: Prisma.TransactionClient, deskId: string, user: AuthUser) {
  const [desk] = await tx.$queryRaw<DeskRow[]>`
    SELECT id, branch_id, current_operator_id
    FROM desks
    WHERE id = ${deskId}::uuid AND is_active
    FOR UPDATE`;
  if (!desk) throw notFound('Box no encontrado');
  if (desk.current_operator_id !== user.sub) throw forbidden('Primero tomá este box para operar');
  return desk;
}

export async function callNext(deskId: string, user: AuthUser) {
  const ticket = await prisma.$transaction(
    async (tx) => {
      const desk = await lockOwnedDesk(tx, deskId, user);

      const active = await tx.ticket.findFirst({ where: { deskId, status: { in: ACTIVE } } });
      if (active) throw conflict(`El box ya tiene el turno ${active.code} en curso. Finalizalo antes de llamar otro.`, 'DESK_BUSY');

      // El corazón del despacho: prioridad DESC, antigüedad ASC, saltando filas bloqueadas.
      // Usa idx_tickets_dispatch (branch_id, status, priority_level DESC, created_at ASC).
      const [next] = await tx.$queryRaw<{ id: string }[]>`
        SELECT t.id
        FROM tickets t
        WHERE t.branch_id = ${desk.branch_id}::uuid
          AND t.status = 'WAITING'
          AND t.service_date = ${businessDate()}::date
          AND (t.type = 'WALK_IN' OR t.checked_in_at IS NOT NULL)
          AND (
            NOT EXISTS (SELECT 1 FROM desk_categories dc WHERE dc.desk_id = ${deskId}::uuid)
            OR t.category_id IN (SELECT dc.category_id FROM desk_categories dc WHERE dc.desk_id = ${deskId}::uuid)
          )
        ORDER BY t.priority_level DESC, t.created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED`;

      if (!next) return null;

      return tx.ticket.update({
        where: { id: next.id },
        data: { status: 'CALLED', deskId, operatorId: user.sub, calledAt: new Date() },
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

/** Carga un ticket y verifica que el usuario opere el box al que fue asignado. */
async function loadTicketForDesk(ticketId: string, user: AuthUser) {
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    include: { ...ticketInclude, desk: { select: { id: true, identifier: true, currentOperatorId: true } } },
  });
  if (!ticket || !ticket.deskId) throw notFound('Turno no encontrado o no asignado a un box');
  const isOwner = ticket.desk?.currentOperatorId === user.sub;
  const isSupervisor = user.role !== 'OPERATOR';
  if (!isOwner && !isSupervisor) throw forbidden('Este turno pertenece a otro box');
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
  data: Prisma.TicketUncheckedUpdateManyInput,
) {
  const current = await loadTicketForDesk(ticketId, user);
  const res = await prisma.ticket.updateMany({
    where: { id: ticketId, deskId: current.deskId, status: { in: from } },
    data,
  });
  if (res.count === 0) throw conflict(`Acción inválida: el turno está en estado ${current.status}`, 'INVALID_TRANSITION');

  const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId }, include: ticketInclude });
  realtime.ticketUpdated(toPublicTicket(ticket));
  realtime.queueUpdated(ticket.branchId);
  return ticket;
}

/** CALLED → IN_SERVICE: el cliente llegó al box. */
export async function startService(ticketId: string, user: AuthUser) {
  return toStaffTicket(await transition(ticketId, user, ['CALLED'], { status: 'IN_SERVICE', startedAt: new Date() }));
}

/** IN_SERVICE → ATTENDED (también permite cerrar directo desde CALLED). */
export async function finishService(ticketId: string, user: AuthUser) {
  const now = new Date();
  const t = await prisma.ticket.findUnique({ where: { id: ticketId }, select: { startedAt: true } });
  return toStaffTicket(
    await transition(ticketId, user, ['CALLED', 'IN_SERVICE'], {
      status: 'ATTENDED',
      startedAt: t?.startedAt ?? now,
      finishedAt: now,
    }),
  );
}

/** CALLED → ABSENT: el cliente no se presentó. */
export async function markAbsent(ticketId: string, user: AuthUser) {
  return toStaffTicket(await transition(ticketId, user, ['CALLED'], { status: 'ABSENT', finishedAt: new Date() }));
}

/** Vuelve a anunciar en la TV un turno ya llamado. */
export async function recall(ticketId: string, user: AuthUser) {
  const ticket = await transition(ticketId, user, ['CALLED'], {
    recallCount: { increment: 1 },
    calledAt: new Date(),
  });
  realtime.ticketCalled(toPublicTicket(ticket), true);
  return toStaffTicket(ticket);
}

/** Devuelve un ticket llamado a la cola (p. ej. el operador se equivocó de box). */
export async function returnToQueue(ticketId: string, user: AuthUser) {
  return toStaffTicket(
    await transition(ticketId, user, ['CALLED'], {
      status: 'WAITING',
      deskId: null,
      operatorId: null,
      calledAt: null,
    }),
  );
}

// ── Gestión de boxes ──────────────────────────────────────────

export async function claimDesk(deskId: string, user: AuthUser) {
  return prisma.$transaction(async (tx) => {
    const desk = await tx.desk.findFirst({ where: { id: deskId, isActive: true } });
    if (!desk) throw notFound('Box no encontrado');
    assertBranchAccess(user, desk.branchId);

    // Un operador ocupa un único box: libera cualquier otro que tuviera tomado.
    await tx.desk.updateMany({
      where: { currentOperatorId: user.sub, id: { not: deskId } },
      data: { currentOperatorId: null },
    });
    const res = await tx.desk.updateMany({
      where: { id: deskId, OR: [{ currentOperatorId: null }, { currentOperatorId: user.sub }] },
      data: { currentOperatorId: user.sub },
    });
    if (res.count === 0) throw conflict('El box ya está ocupado por otro operador', 'DESK_TAKEN');
    return desk;
  }).then((desk) => {
    realtime.queueUpdated(desk.branchId);
    return { id: desk.id, identifier: desk.identifier, branchId: desk.branchId };
  });
}

export async function releaseDesk(deskId: string, user: AuthUser, force = false) {
  const desk = await prisma.desk.findUnique({ where: { id: deskId } });
  if (!desk) throw notFound('Box no encontrado');
  assertBranchAccess(user, desk.branchId);
  if (desk.currentOperatorId !== user.sub && !(force && user.role !== 'OPERATOR')) {
    throw forbidden('Sólo el operador del box o un supervisor pueden liberarlo');
  }
  const active = await prisma.ticket.findFirst({ where: { deskId, status: { in: ACTIVE } } });
  if (active && !force) throw conflict(`Finalizá el turno ${active.code} antes de liberar el box`, 'DESK_BUSY');

  await prisma.desk.update({ where: { id: deskId }, data: { currentOperatorId: null } });
  realtime.queueUpdated(desk.branchId);
  return { ok: true };
}

/** Turno activo del box + atendidos hoy por el operador. */
export async function getDeskState(deskId: string, user: AuthUser) {
  const desk = await prisma.desk.findUnique({
    where: { id: deskId },
    include: { categories: { include: { category: { select: { id: true, name: true, prefixLetter: true } } } } },
  });
  if (!desk) throw notFound('Box no encontrado');
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
      identifier: desk.identifier,
      branchId: desk.branchId,
      isMine: desk.currentOperatorId === user.sub,
      categories: desk.categories.map((c) => ({ id: c.category.id, name: c.category.name, prefix: c.category.prefixLetter })),
    },
    current: current ? toStaffTicket(current) : null,
    attendedToday,
  };
}

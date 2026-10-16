import { prisma } from '../../db/prisma.js';
import { getBrand } from '../../config/brand.js';
import { businessDate, toDbDate } from '../../lib/time.js';
import { ticketInclude, toPublicTicket } from './ticket.dto.js';

/**
 * Condición SQL de "ticket despachable": presencial, o cita ya presentada en el tótem.
 * Se reutiliza en el despacho y en los conteos para que ambos coincidan.
 */
export const DISPATCHABLE_WHERE = { OR: [{ type: 'WALK_IN' as const }, { checkedInAt: { not: null } }] };

/** Estado completo de la cola de una sucursal: lo consumen la TV y los paneles de operador. */
export async function getQueueSnapshot(branchId: string) {
  const day = businessDate();
  const serviceDate = toDbDate(day);
  const brand = getBrand();

  const [categories, waitingGroups, pendingAppointments, statusGroups, recent, desks] = await Promise.all([
    prisma.serviceCategory.findMany({
      where: { branchId, isActive: true },
      orderBy: [{ priorityLevel: 'desc' }, { name: 'asc' }],
      include: { desks: { select: { deskId: true } } },
    }),
    prisma.ticket.groupBy({
      by: ['categoryId'],
      where: { branchId, serviceDate, status: 'WAITING', ...DISPATCHABLE_WHERE },
      _count: { _all: true },
    }),
    prisma.ticket.count({
      where: { branchId, serviceDate, status: 'WAITING', type: 'SCHEDULED', checkedInAt: null },
    }),
    prisma.ticket.groupBy({
      by: ['status'],
      where: { branchId, serviceDate },
      _count: { _all: true },
    }),
    prisma.ticket.findMany({
      where: { branchId, serviceDate, calledAt: { not: null }, status: { not: 'CANCELLED' } },
      orderBy: { calledAt: 'desc' },
      take: brand.display.historySize,
      include: ticketInclude,
    }),
    prisma.desk.findMany({
      where: { branchId, isActive: true },
      select: {
        id: true,
        identifier: true,
        currentOperatorId: true,
        currentOperator: { select: { name: true } },
        categories: { select: { categoryId: true } },
      },
      orderBy: { identifier: 'asc' },
    }),
  ]);

  const waitingBy = new Map(waitingGroups.map((g) => [g.categoryId, g._count._all]));
  const openDesks = desks.filter((d) => d.currentOperatorId);
  const byStatus = Object.fromEntries(statusGroups.map((g) => [g.status, g._count._all]));

  return {
    branchId,
    serviceDate: day,
    updatedAt: new Date().toISOString(),
    totals: {
      waiting: byStatus.WAITING ?? 0,
      called: byStatus.CALLED ?? 0,
      inService: byStatus.IN_SERVICE ?? 0,
      attended: byStatus.ATTENDED ?? 0,
      absent: byStatus.ABSENT ?? 0,
      cancelled: byStatus.CANCELLED ?? 0,
      pendingAppointments,
    },
    categories: categories.map((c) => {
      const waiting = waitingBy.get(c.id) ?? 0;
      // Boxes abiertos que atienden esta cola (un box sin colas asignadas atiende todas)
      const serving = openDesks.filter(
        (d) => d.categories.length === 0 || d.categories.some((dc) => dc.categoryId === c.id),
      ).length;
      return {
        id: c.id,
        name: c.name,
        prefix: c.prefixLetter,
        priorityLevel: c.priorityLevel,
        waiting,
        openDesks: serving,
        estimatedWaitMin: Math.ceil((waiting * c.estimatedDurationMin) / Math.max(1, serving)),
      };
    }),
    desks: desks.map((d) => ({
      id: d.id,
      identifier: d.identifier,
      open: Boolean(d.currentOperatorId),
      operatorName: d.currentOperator?.name ?? null,
    })),
    recentCalls: recent.map(toPublicTicket),
  };
}

export type QueueSnapshot = Awaited<ReturnType<typeof getQueueSnapshot>>;

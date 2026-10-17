import { prisma } from '../../db/prisma.js';
import { getBrand } from '../../config/brand.js';
import { businessDate, toDbDate } from '../../lib/time.js';
import { ticketInclude, toPublicTicket } from './ticket.dto.js';

/**
 * Condición de "ticket despachable": presencial, o cita ya presentada en el tótem.
 * Se reutiliza en el despacho y en los conteos para que ambos coincidan.
 */
export const DISPATCHABLE_WHERE = { OR: [{ type: 'WALK_IN' as const }, { checkedInAt: { not: null } }] };

/**
 * Taquillas que atienden un motivo (y una dependencia, si se indica).
 * Una taquilla sin motivos asignados atiende todos; sin dependencias, atiende todas.
 */
export const servesReason = (reasonId: string, dependencyId?: string | null) => ({
  AND: [
    { OR: [{ reasons: { none: {} } }, { reasons: { some: { reasonId } } }] },
    ...(dependencyId ? [{ OR: [{ dependencies: { none: {} } }, { dependencies: { some: { dependencyId } } }] }] : []),
  ],
});

/** Estado completo de la cola de una sede: lo consumen la TV y los paneles de taquilla. */
export async function getQueueSnapshot(branchId: string) {
  const day = businessDate();
  const serviceDate = toDbDate(day);
  const brand = getBrand();

  const [reasons, dependencies, waitingGroups, depGroups, preferentialWaiting, pendingAppointments, statusGroups, recent, desks] = await Promise.all([
    prisma.attentionReason.findMany({
      where: { branchId, isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { department: 'asc' }, { name: 'asc' }],
    }),
    prisma.dependency.findMany({ where: { branchId, isActive: true }, orderBy: { sortOrder: 'asc' } }),
    prisma.ticket.groupBy({
      by: ['reasonId'],
      where: { branchId, serviceDate, status: 'WAITING', ...DISPATCHABLE_WHERE },
      _count: { _all: true },
    }),
    prisma.ticket.groupBy({
      by: ['dependencyId'],
      where: { branchId, serviceDate, status: 'WAITING', ...DISPATCHABLE_WHERE },
      _count: { _all: true },
    }),
    prisma.ticket.count({
      where: { branchId, serviceDate, status: 'WAITING', preferentialType: { not: null }, ...DISPATCHABLE_WHERE },
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
        number: true,
        identifier: true,
        currentOperatorId: true,
        currentOperator: { select: { name: true } },
        reasons: { select: { reasonId: true } },
        dependencies: { select: { dependencyId: true } },
      },
      orderBy: { number: 'asc' },
    }),
  ]);

  const waitingBy = new Map(waitingGroups.map((g) => [g.reasonId, g._count._all]));
  const waitingByDep = new Map(depGroups.map((g) => [g.dependencyId, g._count._all]));
  const openDesks = desks.filter((d) => d.currentOperatorId);
  const byStatus = Object.fromEntries(statusGroups.map((g) => [g.status, g._count._all]));

  return {
    branchId,
    serviceDate: day,
    updatedAt: new Date().toISOString(),
    totals: {
      waiting: byStatus.WAITING ?? 0,
      waitingPreferential: preferentialWaiting,
      called: byStatus.CALLED ?? 0,
      inService: byStatus.IN_SERVICE ?? 0,
      attended: byStatus.ATTENDED ?? 0,
      absent: byStatus.ABSENT ?? 0,
      cancelled: byStatus.CANCELLED ?? 0,
      pendingAppointments,
    },
    dependencies: dependencies.map((d) => ({
      id: d.id,
      code: d.code,
      name: d.name,
      prefix: d.prefix,
      waiting: waitingByDep.get(d.id) ?? 0,
      openDesks: openDesks.filter((x) => x.dependencies.length === 0 || x.dependencies.some((y) => y.dependencyId === d.id)).length,
    })),
    reasons: reasons.map((r) => {
      const waiting = waitingBy.get(r.id) ?? 0;
      const serving = openDesks.filter((d) => d.reasons.length === 0 || d.reasons.some((x) => x.reasonId === r.id)).length;
      return {
        id: r.id,
        code: r.code,
        name: r.name,
        department: r.department,
        prefix: r.prefixLetter,
        waiting,
        openDesks: serving,
        estimatedWaitMin: Math.ceil((waiting * r.estimatedDurationMin) / Math.max(1, serving)),
      };
    }),
    desks: desks.map((d) => ({
      id: d.id,
      number: d.number,
      identifier: d.identifier,
      open: Boolean(d.currentOperatorId),
      operatorName: d.currentOperator?.name ?? null,
    })),
    recentCalls: recent.map(toPublicTicket),
  };
}

export type QueueSnapshot = Awaited<ReturnType<typeof getQueueSnapshot>>;

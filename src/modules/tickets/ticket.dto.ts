import type { Desk, ServiceCategory, Ticket } from '@prisma/client';

export type TicketWithRelations = Ticket & {
  category: Pick<ServiceCategory, 'id' | 'name' | 'prefixLetter'>;
  desk: Pick<Desk, 'id' | 'identifier'> | null;
};

export const ticketInclude = {
  category: { select: { id: true, name: true, prefixLetter: true } },
  desk: { select: { id: true, identifier: true } },
} as const;

/**
 * Representación pública: se emite por sockets a la sala, por eso NO incluye
 * el identificador del cliente (DNI/teléfono).
 */
export function toPublicTicket(t: TicketWithRelations) {
  return {
    id: t.id,
    branchId: t.branchId,
    code: t.code,
    ticketNumber: t.ticketNumber,
    type: t.type,
    status: t.status,
    category: { id: t.category.id, name: t.category.name, prefix: t.category.prefixLetter },
    desk: t.desk ? { id: t.desk.id, identifier: t.desk.identifier } : null,
    scheduledAt: t.scheduledAt,
    createdAt: t.createdAt,
    checkedInAt: t.checkedInAt,
    calledAt: t.calledAt,
    startedAt: t.startedAt,
    finishedAt: t.finishedAt,
    recallCount: t.recallCount,
  };
}

/** Representación para el personal (incluye datos del cliente). */
export function toStaffTicket(t: TicketWithRelations) {
  return { ...toPublicTicket(t), customerIdentifier: t.customerIdentifier, operatorId: t.operatorId };
}

export type PublicTicket = ReturnType<typeof toPublicTicket>;

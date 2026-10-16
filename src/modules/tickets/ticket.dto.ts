import type { AttentionReason, Desk, Ticket } from '@prisma/client';
import { getBrand } from '../../config/brand.js';
import { formatCedula, maskCedula, spokenIdNumber } from '../../lib/cedula.js';

export type TicketWithRelations = Ticket & {
  reason: Pick<AttentionReason, 'id' | 'code' | 'name' | 'prefixLetter' | 'department'>;
  desk: Pick<Desk, 'id' | 'identifier' | 'number'> | null;
};

export const ticketInclude = {
  reason: { select: { id: true, code: true, name: true, prefixLetter: true, department: true } },
  desk: { select: { id: true, identifier: true, number: true } },
} as const;

/**
 * Representación pública: se emite por sockets a la sala de espera.
 * NO incluye el nombre del ciudadano; la cédula sale enmascarada si
 * brand.display.maskCedula = true (el número completo nunca llega a la TV).
 */
export function toPublicTicket(t: TicketWithRelations) {
  const masked = getBrand().display.maskCedula;
  return {
    id: t.id,
    branchId: t.branchId,
    code: t.code,
    ticketNumber: t.ticketNumber,
    type: t.type,
    status: t.status,
    preferentialType: t.preferentialType,
    reason: { id: t.reason.id, code: t.reason.code, name: t.reason.name, department: t.reason.department },
    desk: t.desk ? { id: t.desk.id, identifier: t.desk.identifier, number: t.desk.number } : null,
    citizen: {
      idOrigin: t.idOrigin,
      display: masked ? maskCedula(t.idOrigin, t.idNumber) : formatCedula(t.idOrigin, t.idNumber),
      /** Para la voz de la TV; null si está enmascarada. */
      spoken: masked ? null : spokenIdNumber(t.idNumber),
    },
    scheduledAt: t.scheduledAt,
    createdAt: t.createdAt,
    checkedInAt: t.checkedInAt,
    calledAt: t.calledAt,
    startedAt: t.startedAt,
    finishedAt: t.finishedAt,
    recallCount: t.recallCount,
  };
}

/** Representación para funcionarios (datos completos + resolución). */
export function toStaffTicket(t: TicketWithRelations) {
  const pub = toPublicTicket(t);
  return {
    ...pub,
    citizen: {
      idOrigin: t.idOrigin,
      idNumber: t.idNumber,
      display: formatCedula(t.idOrigin, t.idNumber),
      name: t.citizenName,
    },
    reason: { ...pub.reason, prefix: t.reason.prefixLetter },
    deskNumber: t.deskNumber,
    operatorId: t.operatorId,
    operatorName: t.operatorName,
    resolutionStatus: t.resolutionStatus,
    resolutionNotes: t.resolutionNotes,
    destinationDepartment: t.destinationDepartment,
    waitSeconds: t.waitSeconds,
    serviceSeconds: t.serviceSeconds,
    serviceDate: t.serviceDate.toISOString().slice(0, 10),
    year: t.year,
    month: t.month,
    day: t.day,
    hour: t.hour,
    dayOfWeek: t.dayOfWeek,
  };
}

export type PublicTicket = ReturnType<typeof toPublicTicket>;
export type StaffTicket = ReturnType<typeof toStaffTicket>;

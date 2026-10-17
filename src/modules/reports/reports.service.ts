import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { badRequest } from '../../lib/errors.js';
import { formatCedula, IdNumberSchema, IdOriginSchema } from '../../lib/cedula.js';
import { toDbDate } from '../../lib/time.js';
import { assertBranchAccess, type AuthUser } from '../../middleware/auth.js';
import { ticketInclude, toStaffTicket } from '../tickets/ticket.dto.js';

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato YYYY-MM-DD');
const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

/**
 * Filtros de reportería. Todos opcionales y combinables (AND).
 * Las fechas `from`/`to` filtran por DÍA DE ATENCIÓN (service_date).
 */
export const ReportFilterSchema = z
  .object({
    branchId: z.string().uuid().optional(),
    from: ymd.optional(),
    to: ymd.optional(),
    year: int(2000, 2100).optional(),
    month: int(1, 12).optional(),
    day: int(1, 31).optional(),
    dayOfWeek: int(1, 7).optional(),
    hour: int(0, 23).optional(),
    deskId: z.string().uuid().optional(),
    deskNumber: int(1, 999).optional(),
    operatorId: z.string().uuid().optional(),
    reasonId: z.string().uuid().optional(),
    dependencyId: z.string().uuid().optional(),
    department: z.string().trim().max(150).optional(),
    status: z.enum(['WAITING', 'CALLED', 'IN_SERVICE', 'ATTENDED', 'ABSENT', 'CANCELLED']).optional(),
    resolutionStatus: z.enum(['RESUELTO', 'EN_TRAMITE', 'REMITIDO', 'NO_PROCEDE', 'PENDIENTE_RECAUDOS']).optional(),
    type: z.enum(['WALK_IN', 'SCHEDULED']).optional(),
    preferential: z.enum(['true', 'false']).optional(),
    idOrigin: IdOriginSchema.optional(),
    idNumber: IdNumberSchema.optional(),
    /** Búsqueda parcial por nombre del ciudadano. */
    name: z.string().trim().min(2).max(80).optional(),
  })
  .refine((f) => !f.from || !f.to || f.from <= f.to, { message: 'La fecha "desde" es posterior a "hasta"', path: ['from'] });

export type ReportFilter = z.infer<typeof ReportFilterSchema>;

/** Traduce los filtros a un `where` de Prisma, aplicando el alcance de sede del usuario. */
export function buildWhere(f: ReportFilter, user: AuthUser): Prisma.TicketWhereInput {
  let branchId = f.branchId;
  if (user.role !== 'ADMIN') {
    if (!user.branchId) throw badRequest('El usuario no tiene sede asignada');
    if (branchId) assertBranchAccess(user, branchId);
    branchId = user.branchId;
  }
  return {
    ...(branchId && { branchId }),
    ...((f.from || f.to) && {
      serviceDate: { ...(f.from && { gte: toDbDate(f.from) }), ...(f.to && { lte: toDbDate(f.to) }) },
    }),
    ...(f.year && { year: f.year }),
    ...(f.month && { month: f.month }),
    ...(f.day && { day: f.day }),
    ...(f.dayOfWeek && { dayOfWeek: f.dayOfWeek }),
    ...(f.hour !== undefined && { hour: f.hour }),
    ...(f.deskId && { deskId: f.deskId }),
    ...(f.deskNumber && { deskNumber: f.deskNumber }),
    ...(f.operatorId && { operatorId: f.operatorId }),
    ...(f.reasonId && { reasonId: f.reasonId }),
    ...(f.dependencyId && { dependencyId: f.dependencyId }),
    ...(f.department && { reason: { department: f.department } }),
    ...(f.status && { status: f.status }),
    ...(f.resolutionStatus && { resolutionStatus: f.resolutionStatus }),
    ...(f.type && { type: f.type }),
    ...(f.preferential && { preferentialType: f.preferential === 'true' ? { not: null } : null }),
    ...(f.idOrigin && { idOrigin: f.idOrigin }),
    ...(f.idNumber && { idNumber: f.idNumber }),
    ...(f.name && { citizenName: { contains: f.name, mode: 'insensitive' as const } }),
  };
}

const ORDER: Prisma.TicketOrderByWithRelationInput[] = [{ serviceDate: 'desc' }, { createdAt: 'desc' }];

export async function listAttentions(where: Prisma.TicketWhereInput, page: number, pageSize: number) {
  const [total, rows] = await Promise.all([
    prisma.ticket.count({ where }),
    prisma.ticket.findMany({ where, orderBy: ORDER, skip: (page - 1) * pageSize, take: pageSize, include: ticketInclude }),
  ]);
  return { total, page, pageSize, pages: Math.ceil(total / pageSize), items: rows.map(toStaffTicket) };
}

// ── Resumen agregado ──────────────────────────────────────────

type GroupField = 'reasonId' | 'dependencyId' | 'deskNumber' | 'operatorName' | 'hour' | 'dayOfWeek' | 'serviceDate' | 'department';

interface StatRow {
  key: string;
  total: number;
  attended: number;
  absent: number;
  cancelled: number;
  pending: number;
  avgWaitMin: number | null;
  avgServiceMin: number | null;
}

const toMin = (seconds: number | null) => (seconds == null ? null : Math.round((seconds / 60) * 10) / 10);

/**
 * Agrupa por `field` × estado y calcula conteos y promedios ponderados de
 * espera y atención (las duraciones ya están precalculadas en segundos).
 */
async function groupStats(where: Prisma.TicketWhereInput, field: Exclude<GroupField, 'department'>): Promise<StatRow[]> {
  // Prisma no puede inferir los tipos de un groupBy con campo dinámico: cast acotado a esta llamada.
  const groupBy = prisma.ticket.groupBy.bind(prisma.ticket) as unknown as (args: object) => Promise<unknown>;
  const groups = (await groupBy({
    by: [field, 'status'],
    where,
    _count: { _all: true, waitSeconds: true, serviceSeconds: true },
    _avg: { waitSeconds: true, serviceSeconds: true },
  })) as Array<
    Record<string, unknown> & {
      status: string;
      _count: { _all: number; waitSeconds: number; serviceSeconds: number };
      _avg: { waitSeconds: number | null; serviceSeconds: number | null };
    }
  >;

  const acc = new Map<string, StatRow & { waitSum: number; waitN: number; svcSum: number; svcN: number }>();
  for (const g of groups) {
    const raw = g[field];
    const key = raw instanceof Date ? raw.toISOString().slice(0, 10) : String(raw ?? '—');
    const row =
      acc.get(key) ??
      { key, total: 0, attended: 0, absent: 0, cancelled: 0, pending: 0, avgWaitMin: null, avgServiceMin: null, waitSum: 0, waitN: 0, svcSum: 0, svcN: 0 };
    const n = g._count._all;
    row.total += n;
    if (g.status === 'ATTENDED') row.attended += n;
    else if (g.status === 'ABSENT') row.absent += n;
    else if (g.status === 'CANCELLED') row.cancelled += n;
    else row.pending += n;
    row.waitSum += (g._avg.waitSeconds ?? 0) * g._count.waitSeconds;
    row.waitN += g._count.waitSeconds;
    row.svcSum += (g._avg.serviceSeconds ?? 0) * g._count.serviceSeconds;
    row.svcN += g._count.serviceSeconds;
    acc.set(key, row);
  }
  return [...acc.values()].map(({ waitSum, waitN, svcSum, svcN, ...r }) => ({
    ...r,
    avgWaitMin: waitN ? toMin(waitSum / waitN) : null,
    avgServiceMin: svcN ? toMin(svcSum / svcN) : null,
  }));
}

export async function summarize(where: Prisma.TicketWhereInput) {
  const attendedWhere = { ...where, status: 'ATTENDED' as const };
  const [overall, byResolution, byReason, byDependency, byDesk, byOperator, byHour, byDayOfWeek, byDay] = await Promise.all([
    prisma.ticket.aggregate({
      where,
      _count: { _all: true, waitSeconds: true },
      _avg: { waitSeconds: true, serviceSeconds: true },
    }),
    prisma.ticket.groupBy({ by: ['resolutionStatus'], where: attendedWhere, _count: { _all: true } }),
    groupStats(where, 'reasonId'),
    groupStats(where, 'dependencyId'),
    groupStats(where, 'deskNumber'),
    groupStats(where, 'operatorName'),
    groupStats(where, 'hour'),
    groupStats(where, 'dayOfWeek'),
    groupStats(where, 'serviceDate'),
  ]);

  // Etiquetas de motivos y totales por Dirección (agregado de los motivos)
  const reasons = await prisma.attentionReason.findMany({
    where: { id: { in: byReason.map((r) => r.key) } },
    select: { id: true, code: true, name: true, department: true },
  });
  const reasonById = new Map(reasons.map((r) => [r.id, r]));
  const byReasonLabeled = byReason
    .map((r) => ({ ...r, code: reasonById.get(r.key)?.code, name: reasonById.get(r.key)?.name, department: reasonById.get(r.key)?.department }))
    .sort((a, b) => b.total - a.total);

  const deps = await prisma.dependency.findMany({
    where: { id: { in: byDependency.map((d) => d.key).filter((k) => k !== '—') } },
    select: { id: true, code: true, name: true },
  });
  const depById = new Map(deps.map((d) => [d.id, d]));
  const byDependencyLabeled = byDependency
    .map((d) => ({ ...d, code: depById.get(d.key)?.code ?? null, name: depById.get(d.key)?.name ?? 'Sin dependencia' }))
    .sort((a, b) => b.total - a.total);

  const deptMap = new Map<string, { key: string; total: number; attended: number; absent: number }>();
  for (const r of byReasonLabeled) {
    const k = r.department ?? '—';
    const d = deptMap.get(k) ?? { key: k, total: 0, attended: 0, absent: 0 };
    d.total += r.total;
    d.attended += r.attended;
    d.absent += r.absent;
    deptMap.set(k, d);
  }

  const totals = byReason.reduce(
    (t, r) => ({ attended: t.attended + r.attended, absent: t.absent + r.absent, cancelled: t.cancelled + r.cancelled, pending: t.pending + r.pending }),
    { attended: 0, absent: 0, cancelled: 0, pending: 0 },
  );

  // Orden numérico; las claves sin valor ("Sin asignar") van al final
  const numeric = (a: StatRow, b: StatRow) => {
    const x = Number(a.key);
    const y = Number(b.key);
    return Number.isNaN(x) ? 1 : Number.isNaN(y) ? -1 : x - y;
  };
  return {
    totals: {
      total: overall._count._all,
      ...totals,
      avgWaitMin: toMin(overall._avg.waitSeconds),
      avgServiceMin: toMin(overall._avg.serviceSeconds),
    },
    byResolution: byResolution
      .map((r) => ({ key: r.resolutionStatus ?? 'SIN_REGISTRO', total: r._count._all }))
      .sort((a, b) => b.total - a.total),
    byDependency: byDependencyLabeled,
    byDepartment: [...deptMap.values()].sort((a, b) => b.total - a.total),
    byReason: byReasonLabeled,
    byDesk: byDesk.sort(numeric),
    byOperator: byOperator.sort((a, b) => b.attended - a.attended),
    byHour: byHour.sort(numeric),
    byDayOfWeek: byDayOfWeek.sort(numeric),
    byDay: byDay.sort((a, b) => a.key.localeCompare(b.key)),
  };
}

// ── Exportación CSV (Excel en español: separador ";" y BOM UTF-8) ──

const RESOLUTION_LABEL: Record<string, string> = {
  RESUELTO: 'Resuelto',
  EN_TRAMITE: 'En trámite',
  REMITIDO: 'Remitido',
  NO_PROCEDE: 'No procede',
  PENDIENTE_RECAUDOS: 'Pendiente de recaudos',
};
const STATUS_LABEL: Record<string, string> = {
  WAITING: 'En espera',
  CALLED: 'Llamado',
  IN_SERVICE: 'En atención',
  ATTENDED: 'Atendido',
  ABSENT: 'Ausente',
  CANCELLED: 'Cancelado',
};
const DOW = ['', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];

const cell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  // Neutraliza fórmulas (CSV injection) y escapa comillas
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[";\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export const CSV_MAX_ROWS = 50_000;

export async function exportCsv(where: Prisma.TicketWhereInput, timezone: string): Promise<string> {
  const rows = await prisma.ticket.findMany({
    where,
    orderBy: ORDER,
    take: CSV_MAX_ROWS,
    include: {
      reason: { select: { code: true, name: true, department: true } },
      dependency: { select: { name: true } },
      branch: { select: { code: true } },
    },
  });
  const time = (d: Date | null) =>
    d ? d.toLocaleTimeString('es-VE', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false }) : '';
  const min = (s: number | null) => (s == null ? '' : (s / 60).toFixed(1).replace('.', ','));

  const header = [
    'Sede', 'Fecha', 'Año', 'Mes', 'Día', 'Día semana', 'Hora', 'Turno', 'Tipo', 'Cédula', 'Ciudadano', 'Preferencial',
    'Dependencia', 'Cód. motivo', 'Motivo', 'Dirección', 'Taquilla', 'Funcionario', 'Estatus', 'Resultado', 'Remitido a', 'Observaciones',
    'Llegada', 'Llamado', 'Inicio atención', 'Fin atención', 'Espera (min)', 'Atención (min)',
  ];
  const lines = rows.map((t) =>
    [
      t.branch.code, t.serviceDate.toISOString().slice(0, 10), t.year, t.month, t.day, DOW[t.dayOfWeek], t.hour, t.code,
      t.type === 'SCHEDULED' ? 'Cita' : 'Presencial', formatCedula(t.idOrigin, t.idNumber), t.citizenName,
      t.preferentialType ?? '', t.dependency?.name ?? '', t.reason.code, t.reason.name, t.reason.department, t.deskNumber ?? '', t.operatorName ?? '',
      STATUS_LABEL[t.status], t.resolutionStatus ? RESOLUTION_LABEL[t.resolutionStatus] : '', t.destinationDepartment ?? '',
      t.resolutionNotes ?? '', time(t.checkedInAt ?? t.createdAt), time(t.calledAt), time(t.startedAt), time(t.finishedAt),
      min(t.waitSeconds), min(t.serviceSeconds),
    ]
      .map(cell)
      .join(';'),
  );
  return '﻿' + [header.join(';'), ...lines].join('\r\n');
}

/** Valores posibles para los selectores de filtros. */
export async function filterOptions(branchId: string | undefined) {
  const branchWhere = branchId ? { branchId } : {};
  const [desks, reasons, operators, branches, dependencies] = await Promise.all([
    prisma.desk.findMany({ where: branchWhere, select: { id: true, number: true, identifier: true, branchId: true }, orderBy: { number: 'asc' } }),
    prisma.attentionReason.findMany({
      where: branchWhere,
      select: { id: true, code: true, name: true, department: true, isActive: true },
      // Activos primero en el orden del catálogo; los inactivos (histórico) al final
      orderBy: [{ isActive: 'desc' }, { sortOrder: 'asc' }, { department: 'asc' }, { code: 'asc' }],
    }),
    prisma.user.findMany({
      where: { ...(branchId ? { OR: [{ branchId }, { role: 'ADMIN' }] } : {}) },
      select: { id: true, name: true, role: true },
      orderBy: { name: 'asc' },
    }),
    prisma.branch.findMany({ select: { id: true, code: true, name: true }, orderBy: { name: 'asc' } }),
    prisma.dependency.findMany({ where: branchWhere, select: { id: true, code: true, name: true }, orderBy: { sortOrder: 'asc' } }),
  ]);
  return {
    branches,
    dependencies,
    desks,
    reasons,
    operators,
    // En el orden del catálogo (sortOrder), no alfabético
    departments: [...new Set(reasons.map((r) => r.department))],
  };
}

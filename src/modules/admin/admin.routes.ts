import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { conflict, notFound } from '../../lib/errors.js';
import { assertBranchAccess, requireAuth, requireRole, type AuthUser } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { realtime } from '../../sockets/index.js';
import { ticketInclude, toPublicTicket, toStaffTicket } from '../tickets/ticket.dto.js';

/**
 * Administración.
 *  - ADMIN: gestiona sedes, taquillas, usuarios y motivos de todas las sedes.
 *  - SUPERVISOR: gestiona los motivos de atención y los turnos de SU sede.
 */
export const adminRouter = Router();
adminRouter.use(requireAuth);

const me = (res: { locals: Record<string, unknown> }) => res.locals.user as AuthUser;
const uuid = z.string().uuid();
const idParam = validate({ params: z.object({ id: uuid }) });
const onlyAdmin = requireRole('ADMIN');
const supervisors = requireRole('ADMIN', 'SUPERVISOR');

// ── Sedes ──
const BranchBody = z.object({
  name: z.string().trim().min(2).max(120),
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{2,20}$/),
  address: z.string().trim().max(255).optional(),
  isActive: z.boolean().optional(),
});

adminRouter.get('/branches', supervisors, async (_req, res) => {
  res.json(await prisma.branch.findMany({ orderBy: { name: 'asc' } }));
});
adminRouter.post('/branches', onlyAdmin, validate({ body: BranchBody }), async (_req, res) => {
  res.status(201).json(await prisma.branch.create({ data: res.locals.body }));
});
adminRouter.patch('/branches/:id', onlyAdmin, idParam, validate({ body: BranchBody.partial() }), async (_req, res) => {
  res.json(await prisma.branch.update({ where: { id: res.locals.params.id }, data: res.locals.body }));
});

// ── Motivos de atención (tabla maestra) ──
const ReasonBody = z.object({
  branchId: uuid,
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9][A-Z0-9_-]{1,19}$/, 'Código: letras, números y guiones (ej. NOM-01)'),
  name: z.string().trim().min(3).max(120),
  description: z.string().trim().max(1000).optional().nullable(),
  department: z.string().trim().min(3, 'Indique la Dirección o unidad responsable').max(150),
  prefixLetter: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{1,3}$/, 'Prefijo: 1 a 3 letras (ej. N, JUB)'),
  priorityLevel: z.number().int().min(0).max(100).default(0),
  estimatedDurationMin: z.number().int().min(1).max(480).default(10),
  allowAppointments: z.boolean().default(true),
  isActive: z.boolean().default(true),
  /** Orden en el tótem; las Direcciones se ordenan por su primer trámite. */
  sortOrder: z.number().int().min(0).max(10_000).default(0),
});

async function loadReasonFor(user: AuthUser, id: string) {
  const reason = await prisma.attentionReason.findUnique({ where: { id } });
  if (!reason) throw notFound('Motivo no encontrado');
  assertBranchAccess(user, reason.branchId);
  return reason;
}

adminRouter.get(
  '/reasons',
  supervisors,
  validate({
    query: z.object({
      branchId: uuid,
      includeInactive: z.enum(['true', 'false']).default('true'),
    }),
  }),
  async (_req, res) => {
    const { branchId, includeInactive } = res.locals.query;
    assertBranchAccess(me(res), branchId);
    const reasons = await prisma.attentionReason.findMany({
      where: { branchId, ...(includeInactive === 'false' ? { isActive: true } : {}) },
      orderBy: [{ sortOrder: 'asc' }, { department: 'asc' }, { code: 'asc' }],
      include: { _count: { select: { tickets: true } } },
    });
    res.json(reasons.map(({ _count, ...r }) => ({ ...r, ticketCount: _count.tickets })));
  },
);

adminRouter.post('/reasons', supervisors, validate({ body: ReasonBody }), async (_req, res) => {
  assertBranchAccess(me(res), res.locals.body.branchId);
  const reason = await prisma.attentionReason.create({ data: res.locals.body });
  realtime.queueUpdated(reason.branchId);
  res.status(201).json(reason);
});

adminRouter.patch(
  '/reasons/:id',
  supervisors,
  idParam,
  validate({ body: ReasonBody.omit({ branchId: true }).partial() }),
  async (_req, res) => {
    await loadReasonFor(me(res), res.locals.params.id);
    const reason = await prisma.attentionReason.update({ where: { id: res.locals.params.id }, data: res.locals.body });
    realtime.queueUpdated(reason.branchId);
    res.json(reason);
  },
);

/** Sólo se eliminan motivos sin atenciones registradas; los demás se desactivan (se preserva el histórico). */
adminRouter.delete('/reasons/:id', supervisors, idParam, async (_req, res) => {
  const reason = await loadReasonFor(me(res), res.locals.params.id);
  const used = await prisma.ticket.count({ where: { reasonId: reason.id } });
  if (used > 0) {
    throw conflict(`El motivo tiene ${used} atenciones registradas. Desactívelo en lugar de eliminarlo.`, 'REASON_IN_USE');
  }
  await prisma.attentionReason.delete({ where: { id: reason.id } });
  realtime.queueUpdated(reason.branchId);
  res.status(204).end();
});

/** Direcciones / unidades ya cargadas (para autocompletar). */
adminRouter.get('/departments', supervisors, async (_req, res) => {
  const rows = await prisma.attentionReason.findMany({ distinct: ['department'], select: { department: true }, orderBy: { department: 'asc' } });
  res.json(rows.map((r) => r.department));
});

// ── Dependencias (bifurcación del tótem: Zona Educativa / Atención al Ciudadano) ──
const DependencyBody = z.object({
  branchId: uuid,
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]{0,9}$/, 'Código: hasta 10 letras/números (ej. ZE)'),
  name: z.string().trim().min(3).max(120),
  description: z.string().trim().max(500).optional().nullable(),
  icon: z.string().trim().max(8).optional().nullable(),
  prefix: z.string().trim().toUpperCase().regex(/^[A-Z]{1,3}$/, 'Prefijo del turno: 1 a 3 letras (ej. ZE, OAC)'),
  sortOrder: z.number().int().min(0).max(1000).default(0),
  isActive: z.boolean().default(true),
});

adminRouter.get('/dependencies', supervisors, validate({ query: z.object({ branchId: uuid }) }), async (_req, res) => {
  assertBranchAccess(me(res), res.locals.query.branchId);
  res.json(await prisma.dependency.findMany({ where: { branchId: res.locals.query.branchId }, orderBy: { sortOrder: 'asc' } }));
});
adminRouter.post('/dependencies', onlyAdmin, validate({ body: DependencyBody }), async (_req, res) => {
  const dep = await prisma.dependency.create({ data: res.locals.body });
  realtime.queueUpdated(dep.branchId);
  res.status(201).json(dep);
});
adminRouter.patch(
  '/dependencies/:id',
  onlyAdmin,
  idParam,
  validate({ body: DependencyBody.omit({ branchId: true }).partial() }),
  async (_req, res) => {
    const dep = await prisma.dependency.update({ where: { id: res.locals.params.id }, data: res.locals.body });
    realtime.queueUpdated(dep.branchId);
    res.json(dep);
  },
);

// ── Taquillas ──
const DeskBody = z.object({
  branchId: uuid,
  number: z.number().int().min(1).max(999),
  identifier: z.string().trim().min(1).max(40),
  isActive: z.boolean().optional(),
  /** Motivos que atiende. Vacío = todos. */
  reasonIds: z.array(uuid).default([]),
  /** Dependencias que atiende. Vacío = todas. */
  dependencyIds: z.array(uuid).default([]),
});

adminRouter.get('/desks', supervisors, validate({ query: z.object({ branchId: uuid }) }), async (_req, res) => {
  assertBranchAccess(me(res), res.locals.query.branchId);
  res.json(
    await prisma.desk.findMany({
      where: { branchId: res.locals.query.branchId },
      include: { reasons: true, dependencies: true, currentOperator: { select: { id: true, name: true } } },
      orderBy: { number: 'asc' },
    }),
  );
});
adminRouter.post('/desks', onlyAdmin, validate({ body: DeskBody }), async (_req, res) => {
  const { reasonIds, dependencyIds, ...data } = res.locals.body;
  res.status(201).json(
    await prisma.desk.create({
      data: {
        ...data,
        reasons: { create: reasonIds.map((reasonId: string) => ({ reasonId })) },
        dependencies: { create: dependencyIds.map((dependencyId: string) => ({ dependencyId })) },
      },
      include: { reasons: true, dependencies: true },
    }),
  );
});
adminRouter.patch(
  '/desks/:id',
  onlyAdmin,
  idParam,
  validate({ body: DeskBody.omit({ branchId: true }).partial() }),
  async (_req, res) => {
    const { reasonIds, dependencyIds, ...data } = res.locals.body;
    const id = res.locals.params.id;
    const desk = await prisma.$transaction(async (tx) => {
      if (reasonIds) {
        await tx.deskReason.deleteMany({ where: { deskId: id } });
        await tx.deskReason.createMany({ data: reasonIds.map((reasonId: string) => ({ deskId: id, reasonId })) });
      }
      if (dependencyIds) {
        await tx.deskDependency.deleteMany({ where: { deskId: id } });
        await tx.deskDependency.createMany({ data: dependencyIds.map((dependencyId: string) => ({ deskId: id, dependencyId })) });
      }
      return tx.desk.update({ where: { id }, data, include: { reasons: true, dependencies: true } });
    });
    realtime.queueUpdated(desk.branchId);
    res.json(desk);
  },
);

// ── Usuarios / funcionarios ──
const UserBody = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres'),
  role: z.enum(['ADMIN', 'SUPERVISOR', 'OPERATOR']).default('OPERATOR'),
  branchId: uuid.nullable().optional(),
  isActive: z.boolean().optional(),
});
const publicUser = { id: true, name: true, email: true, role: true, branchId: true, isActive: true, createdAt: true } as const;

adminRouter.get('/users', onlyAdmin, async (_req, res) => {
  res.json(await prisma.user.findMany({ select: publicUser, orderBy: { name: 'asc' } }));
});
adminRouter.post('/users', onlyAdmin, validate({ body: UserBody }), async (_req, res) => {
  const { password, ...data } = res.locals.body;
  if (data.role !== 'ADMIN' && !data.branchId) throw conflict('Operadores y supervisores deben pertenecer a una sede');
  res.status(201).json(
    await prisma.user.create({ data: { ...data, passwordHash: await bcrypt.hash(password, 12) }, select: publicUser }),
  );
});
adminRouter.patch('/users/:id', onlyAdmin, idParam, validate({ body: UserBody.partial() }), async (_req, res) => {
  const { password, ...data } = res.locals.body;
  res.json(
    await prisma.user.update({
      where: { id: res.locals.params.id },
      data: { ...data, ...(password ? { passwordHash: await bcrypt.hash(password, 12) } : {}) },
      select: publicUser,
    }),
  );
});

// ── Supervisión de turnos ──

/** Supervisor anula un turno en espera o llamado. */
adminRouter.post('/tickets/:id/cancel', supervisors, idParam, async (_req, res) => {
  const t = await prisma.ticket.findUniqueOrThrow({ where: { id: res.locals.params.id } });
  assertBranchAccess(me(res), t.branchId);
  const r = await prisma.ticket.updateMany({
    where: { id: t.id, status: { in: ['WAITING', 'CALLED'] } },
    data: { status: 'CANCELLED', finishedAt: new Date() },
  });
  if (r.count === 0) throw conflict('El turno no puede anularse en su estado actual');
  const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: t.id }, include: ticketInclude });
  realtime.ticketUpdated(toPublicTicket(ticket));
  realtime.queueUpdated(ticket.branchId);
  res.json(toStaffTicket(ticket));
});

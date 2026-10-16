import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { env } from '../../config/env.js';
import { conflict } from '../../lib/errors.js';
import { businessDate, toDbDate } from '../../lib/time.js';
import { assertBranchAccess, requireAuth, requireRole, type AuthUser } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { realtime } from '../../sockets/index.js';
import { ticketInclude, toPublicTicket, toStaffTicket } from '../tickets/ticket.dto.js';

/**
 * Administración y supervisión.
 *  - ADMIN: gestiona sucursales, colas, boxes y usuarios.
 *  - SUPERVISOR: consulta métricas y gestiona turnos de su sucursal.
 */
export const adminRouter = Router();
adminRouter.use(requireAuth);

const me = (res: { locals: Record<string, unknown> }) => res.locals.user as AuthUser;
const uuid = z.string().uuid();
const idParam = validate({ params: z.object({ id: uuid }) });
const onlyAdmin = requireRole('ADMIN');
const supervisors = requireRole('ADMIN', 'SUPERVISOR');

// ── Sucursales ──
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

// ── Colas / trámites ──
const CategoryBody = z.object({
  branchId: uuid,
  name: z.string().trim().min(2).max(80),
  prefixLetter: z.string().trim().toUpperCase().regex(/^[A-Z]{1,3}$/),
  priorityLevel: z.number().int().min(0).max(100).default(0),
  estimatedDurationMin: z.number().int().min(1).max(480).default(10),
  allowAppointments: z.boolean().default(true),
  isActive: z.boolean().optional(),
});

adminRouter.get(
  '/categories',
  supervisors,
  validate({ query: z.object({ branchId: uuid }) }),
  async (_req, res) => {
    assertBranchAccess(me(res), res.locals.query.branchId);
    res.json(await prisma.serviceCategory.findMany({ where: { branchId: res.locals.query.branchId }, orderBy: { prefixLetter: 'asc' } }));
  },
);
adminRouter.post('/categories', onlyAdmin, validate({ body: CategoryBody }), async (_req, res) => {
  res.status(201).json(await prisma.serviceCategory.create({ data: res.locals.body }));
});
adminRouter.patch(
  '/categories/:id',
  onlyAdmin,
  idParam,
  validate({ body: CategoryBody.omit({ branchId: true }).partial() }),
  async (_req, res) => {
    res.json(await prisma.serviceCategory.update({ where: { id: res.locals.params.id }, data: res.locals.body }));
  },
);

// ── Boxes ──
const DeskBody = z.object({
  branchId: uuid,
  identifier: z.string().trim().min(1).max(40),
  isActive: z.boolean().optional(),
  /** Colas que atiende. Vacío = todas. */
  categoryIds: z.array(uuid).default([]),
});

adminRouter.get('/desks', supervisors, validate({ query: z.object({ branchId: uuid }) }), async (_req, res) => {
  assertBranchAccess(me(res), res.locals.query.branchId);
  res.json(
    await prisma.desk.findMany({
      where: { branchId: res.locals.query.branchId },
      include: { categories: true, currentOperator: { select: { id: true, name: true } } },
      orderBy: { identifier: 'asc' },
    }),
  );
});
adminRouter.post('/desks', onlyAdmin, validate({ body: DeskBody }), async (_req, res) => {
  const { categoryIds, ...data } = res.locals.body;
  res.status(201).json(
    await prisma.desk.create({
      data: { ...data, categories: { create: categoryIds.map((categoryId: string) => ({ categoryId })) } },
      include: { categories: true },
    }),
  );
});
adminRouter.patch(
  '/desks/:id',
  onlyAdmin,
  idParam,
  validate({ body: DeskBody.omit({ branchId: true }).partial() }),
  async (_req, res) => {
    const { categoryIds, ...data } = res.locals.body;
    const id = res.locals.params.id;
    const desk = await prisma.$transaction(async (tx) => {
      if (categoryIds) {
        await tx.deskCategory.deleteMany({ where: { deskId: id } });
        await tx.deskCategory.createMany({ data: categoryIds.map((categoryId: string) => ({ deskId: id, categoryId })) });
      }
      return tx.desk.update({ where: { id }, data, include: { categories: true } });
    });
    realtime.queueUpdated(desk.branchId);
    res.json(desk);
  },
);

// ── Usuarios ──
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
  if (data.role !== 'ADMIN' && !data.branchId) throw conflict('Operadores y supervisores deben pertenecer a una sucursal');
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

// ── Supervisión ──

/** Turnos del día de una sucursal (filtro opcional por estado). */
adminRouter.get(
  '/branches/:id/tickets',
  supervisors,
  idParam,
  validate({
    query: z.object({
      status: z.enum(['WAITING', 'CALLED', 'IN_SERVICE', 'ATTENDED', 'ABSENT', 'CANCELLED']).optional(),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }),
  }),
  async (_req, res) => {
    const branchId = res.locals.params.id;
    assertBranchAccess(me(res), branchId);
    const tickets = await prisma.ticket.findMany({
      where: {
        branchId,
        serviceDate: toDbDate(res.locals.query.date ?? businessDate()),
        ...(res.locals.query.status ? { status: res.locals.query.status } : {}),
      },
      orderBy: [{ priorityLevel: 'desc' }, { createdAt: 'asc' }],
      include: ticketInclude,
    });
    res.json(tickets.map(toStaffTicket));
  },
);

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

/** Métricas del día: tiempos medios de espera y atención, por cola y por operador. */
adminRouter.get(
  '/branches/:id/stats',
  supervisors,
  idParam,
  validate({ query: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }) }),
  async (_req, res) => {
    const branchId = res.locals.params.id;
    assertBranchAccess(me(res), branchId);
    const date = res.locals.query.date ?? businessDate();

    const byCategory = await prisma.$queryRaw<unknown[]>`
      SELECT c.name, c.prefix_letter AS prefix,
             count(*)::int AS total,
             count(*) FILTER (WHERE t.status = 'ATTENDED')::int AS attended,
             count(*) FILTER (WHERE t.status = 'ABSENT')::int AS absent,
             count(*) FILTER (WHERE t.status = 'WAITING')::int AS waiting,
             round(avg(extract(epoch FROM t.called_at - coalesce(t.checked_in_at, t.created_at))) / 60, 1)::float AS avg_wait_min,
             round(avg(extract(epoch FROM t.finished_at - t.started_at)) FILTER (WHERE t.status = 'ATTENDED') / 60, 1)::float AS avg_service_min
      FROM tickets t
      JOIN service_categories c ON c.id = t.category_id
      WHERE t.branch_id = ${branchId}::uuid AND t.service_date = ${date}::date
      GROUP BY c.name, c.prefix_letter
      ORDER BY c.prefix_letter`;

    const byOperator = await prisma.$queryRaw<unknown[]>`
      SELECT u.name,
             count(*) FILTER (WHERE t.status = 'ATTENDED')::int AS attended,
             count(*) FILTER (WHERE t.status = 'ABSENT')::int AS absent,
             round(avg(extract(epoch FROM t.finished_at - t.started_at)) FILTER (WHERE t.status = 'ATTENDED') / 60, 1)::float AS avg_service_min
      FROM tickets t
      JOIN users u ON u.id = t.operator_id
      WHERE t.branch_id = ${branchId}::uuid AND t.service_date = ${date}::date
      GROUP BY u.name
      ORDER BY attended DESC`;

    const hourly = await prisma.$queryRaw<unknown[]>`
      SELECT extract(hour FROM t.created_at AT TIME ZONE ${env.APP_TIMEZONE})::int AS hour, count(*)::int AS issued
      FROM tickets t
      WHERE t.branch_id = ${branchId}::uuid AND t.service_date = ${date}::date
      GROUP BY 1 ORDER BY 1`;

    res.json({ date, byCategory, byOperator, hourly });
  },
);

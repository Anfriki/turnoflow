import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { env, isProd } from '../../config/env.js';
import { prisma } from '../../db/prisma.js';
import { notFound } from '../../lib/errors.js';
import { validate } from '../../middleware/validate.js';
import { getQueueSnapshot } from '../tickets/queue.service.js';
import {
  bookAppointment,
  cancelTicket,
  checkInAppointment,
  getAvailability,
  getTicketStatus,
  issueWalkInTicket,
} from '../tickets/tickets.service.js';

/** Endpoints sin autenticación: tótem, web de clientes y pantalla de sala. */
export const publicRouter = Router();

// Freno a abusos de emisión desde una misma IP (desactivado fuera de producción).
const issueLimiter = rateLimit({
  windowMs: 60_000,
  limit: env.RATE_LIMIT_PUBLIC_PER_MIN,
  skip: () => !isProd,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'RATE_LIMITED', message: 'Demasiadas solicitudes, intentá de nuevo en un minuto' },
});

const uuid = z.string().uuid();
const customerIdentifier = z.string().trim().min(3, 'Mínimo 3 caracteres').max(80);
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato YYYY-MM-DD');
const hhmm = z.string().regex(/^\d{2}:\d{2}$/, 'Formato HH:mm');

publicRouter.get('/branches', async (_req, res) => {
  res.json(
    await prisma.branch.findMany({
      where: { isActive: true },
      select: { id: true, name: true, code: true, address: true },
      orderBy: { name: 'asc' },
    }),
  );
});

publicRouter.get(
  '/branches/:code',
  validate({ params: z.object({ code: z.string().min(1).max(20) }) }),
  async (_req, res) => {
    const branch = await prisma.branch.findFirst({
      where: { code: res.locals.params.code.toUpperCase(), isActive: true },
      select: {
        id: true,
        name: true,
        code: true,
        address: true,
        categories: {
          where: { isActive: true },
          orderBy: [{ priorityLevel: 'desc' }, { name: 'asc' }],
          select: {
            id: true,
            name: true,
            prefixLetter: true,
            priorityLevel: true,
            estimatedDurationMin: true,
            allowAppointments: true,
          },
        },
      },
    });
    if (!branch) throw notFound('Sucursal no encontrada');
    res.json(branch);
  },
);

/** Estado inicial para la TV (luego se actualiza por socket). */
publicRouter.get('/branches/:id/queue', validate({ params: z.object({ id: uuid }) }), async (_req, res) => {
  res.json(await getQueueSnapshot(res.locals.params.id));
});

// ── Turnos presenciales ──
publicRouter.post(
  '/tickets',
  issueLimiter,
  validate({
    body: z.object({
      branchId: uuid,
      categoryId: uuid,
      customerIdentifier: customerIdentifier.optional().or(z.literal('')),
    }),
  }),
  async (_req, res) => {
    res.status(201).json(await issueWalkInTicket(res.locals.body));
  },
);

publicRouter.get('/tickets/:id', validate({ params: z.object({ id: uuid }) }), async (_req, res) => {
  res.json(await getTicketStatus(res.locals.params.id));
});

publicRouter.post('/tickets/:id/cancel', validate({ params: z.object({ id: uuid }) }), async (_req, res) => {
  res.json(await cancelTicket(res.locals.params.id));
});

// ── Citas previas ──
publicRouter.get(
  '/appointments/availability',
  validate({ query: z.object({ branchId: uuid, categoryId: uuid, date: ymd }) }),
  async (_req, res) => {
    res.json(await getAvailability(res.locals.query));
  },
);

publicRouter.post(
  '/appointments',
  issueLimiter,
  validate({ body: z.object({ branchId: uuid, categoryId: uuid, customerIdentifier, date: ymd, time: hhmm }) }),
  async (_req, res) => {
    res.status(201).json(await bookAppointment(res.locals.body));
  },
);

publicRouter.post(
  '/appointments/check-in',
  issueLimiter,
  validate({ body: z.object({ branchId: uuid, customerIdentifier }) }),
  async (_req, res) => {
    res.json(await checkInAppointment(res.locals.body));
  },
);

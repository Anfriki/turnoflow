import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { env, isProd } from '../../config/env.js';
import { prisma } from '../../db/prisma.js';
import { notFound } from '../../lib/errors.js';
import { checkCitizenId, CitizenNameSchema, IdNumberSchema, IdOriginSchema, maskName } from '../../lib/cedula.js';
import { validate } from '../../middleware/validate.js';
import { citizenLookupService } from '../citizens/citizen-lookup.service.js';
import { getQueueSnapshot } from '../tickets/queue.service.js';
import {
  bookAppointment,
  cancelTicket,
  checkInAppointment,
  getAvailability,
  getTicketStatus,
  issueWalkInTicket,
} from '../tickets/tickets.service.js';

/** Endpoints sin autenticación: tótem, web ciudadana y pantalla de sala. */
export const publicRouter = Router();

const limiter = (limit: number, message: string) =>
  rateLimit({
    windowMs: 60_000,
    limit,
    skip: () => !isProd,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'RATE_LIMITED', message },
  });

// Freno a abusos de emisión desde una misma IP (desactivado fuera de producción).
const issueLimiter = limiter(env.RATE_LIMIT_PUBLIC_PER_MIN, 'Demasiadas solicitudes, intente de nuevo en un minuto');
// La consulta de cédulas devuelve datos personales: límite más estricto contra la enumeración.
const lookupLimiter = limiter(env.RATE_LIMIT_LOOKUP_PER_MIN, 'Demasiadas consultas de cédula, intente de nuevo en un minuto');

const uuid = z.string().uuid();
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato YYYY-MM-DD');
const hhmm = z.string().regex(/^\d{2}:\d{2}$/, 'Formato HH:mm');
const preferentialType = z.enum(['TERCERA_EDAD', 'EMBARAZADA', 'DISCAPACIDAD']).nullable().optional();

const citizenId = { idOrigin: IdOriginSchema, idNumber: IdNumberSchema };
const citizen = { ...citizenId, citizenName: CitizenNameSchema };

publicRouter.get('/branches', async (_req, res) => {
  res.json(
    await prisma.branch.findMany({
      where: { isActive: true },
      select: { id: true, name: true, code: true, address: true },
      orderBy: { name: 'asc' },
    }),
  );
});

/** Sede + motivos de atención activos (alimenta el selector del tótem). */
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
        reasons: {
          where: { isActive: true },
          orderBy: [{ department: 'asc' }, { name: 'asc' }],
          select: {
            id: true,
            code: true,
            name: true,
            description: true,
            department: true,
            priorityLevel: true,
            estimatedDurationMin: true,
            allowAppointments: true,
          },
        },
      },
    });
    if (!branch) throw notFound('Sede no encontrada');
    res.json(branch);
  },
);

/** Estado inicial para la TV (luego se actualiza por socket). */
publicRouter.get('/branches/:id/queue', validate({ params: z.object({ id: uuid }) }), async (_req, res) => {
  res.json(await getQueueSnapshot(res.locals.params.id));
});

// ── Consulta de ciudadano (autocompletado del nombre) ──
publicRouter.get(
  '/citizens/lookup',
  lookupLimiter,
  validate({ query: z.object(citizenId).superRefine(checkCitizenId) }),
  async (_req, res) => {
    const { idOrigin, idNumber } = res.locals.query;
    const result = await citizenLookupService.lookup(idOrigin, idNumber);
    res.json(
      env.CITIZEN_LOOKUP_MASK_PUBLIC && result.fullName
        ? { ...result, fullName: maskName(result.fullName), masked: true }
        : { ...result, masked: false },
    );
  },
);

// ── Turnos presenciales ──
publicRouter.post(
  '/tickets',
  issueLimiter,
  validate({
    body: z.object({ branchId: uuid, reasonId: uuid, preferentialType, ...citizen }).superRefine(checkCitizenId),
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
  validate({ query: z.object({ branchId: uuid, reasonId: uuid, date: ymd }) }),
  async (_req, res) => {
    res.json(await getAvailability(res.locals.query));
  },
);

publicRouter.post(
  '/appointments',
  issueLimiter,
  validate({
    body: z
      .object({ branchId: uuid, reasonId: uuid, date: ymd, time: hhmm, preferentialType, ...citizen })
      .superRefine(checkCitizenId),
  }),
  async (_req, res) => {
    res.status(201).json(await bookAppointment(res.locals.body));
  },
);

publicRouter.post(
  '/appointments/check-in',
  issueLimiter,
  validate({ body: z.object({ branchId: uuid, ...citizenId }).superRefine(checkCitizenId) }),
  async (_req, res) => {
    res.json(await checkInAppointment(res.locals.body));
  },
);

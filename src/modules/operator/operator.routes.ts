import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { getBrand } from '../../config/brand.js';
import { badRequest } from '../../lib/errors.js';
import { assertBranchAccess, requireAuth, requireRole, type AuthUser } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import {
  callNext,
  claimDesk,
  finishService,
  getDeskState,
  markAbsent,
  recall,
  releaseDesk,
  returnToQueue,
  startService,
} from './dispatcher.service.js';

/** Panel de taquilla: todos los roles pueden operar una taquilla. */
export const operatorRouter = Router();
operatorRouter.use(requireAuth, requireRole('OPERATOR', 'SUPERVISOR', 'ADMIN'));

const idParam = validate({ params: z.object({ id: z.string().uuid() }) });
const me = (res: { locals: Record<string, unknown> }) => res.locals.user as AuthUser;

/** Cierre de atención: el resultado de la petición es obligatorio. */
export const ResolutionSchema = z
  .object({
    resolutionStatus: z.enum(['RESUELTO', 'EN_TRAMITE', 'REMITIDO', 'NO_PROCEDE', 'PENDIENTE_RECAUDOS'], {
      message: 'Seleccione el estatus de la petición',
    }),
    resolutionNotes: z.string().trim().max(2000, 'Máximo 2000 caracteres'),
    destinationDepartment: z.string().trim().max(150).optional().nullable(),
  })
  .superRefine((v, ctx) => {
    const min = getBrand().attention.minResolutionNotes;
    if (v.resolutionNotes.length < min) {
      ctx.addIssue({ code: 'custom', path: ['resolutionNotes'], message: `Las observaciones deben tener al menos ${min} caracteres` });
    }
    if (v.resolutionStatus === 'REMITIDO' && !v.destinationDepartment) {
      ctx.addIssue({ code: 'custom', path: ['destinationDepartment'], message: 'Indique la unidad o dependencia a la que se remite' });
    }
  });

/** Taquillas de la sede del usuario (ADMIN debe indicar ?branchId=). */
operatorRouter.get(
  '/desks',
  validate({ query: z.object({ branchId: z.string().uuid().optional() }) }),
  async (_req, res) => {
    const user = me(res);
    const branchId = res.locals.query.branchId ?? user.branchId;
    if (!branchId) throw badRequest('Indique branchId');
    assertBranchAccess(user, branchId);
    const desks = await prisma.desk.findMany({
      where: { branchId, isActive: true },
      orderBy: { number: 'asc' },
      select: {
        id: true,
        number: true,
        identifier: true,
        currentOperatorId: true,
        currentOperator: { select: { name: true } },
        reasons: { select: { reason: { select: { code: true, name: true } } } },
      },
    });
    res.json(
      desks.map((d) => ({
        id: d.id,
        number: d.number,
        identifier: d.identifier,
        occupiedBy: d.currentOperator?.name ?? null,
        isMine: d.currentOperatorId === user.sub,
        reasons: d.reasons.map((r) => `${r.reason.code} · ${r.reason.name}`),
      })),
    );
  },
);

/** Direcciones / dependencias conocidas (para autocompletar el destino de una remisión). */
operatorRouter.get('/departments', async (_req, res) => {
  const rows = await prisma.$queryRaw<{ name: string }[]>`
    SELECT DISTINCT department AS name FROM attention_reasons WHERE department <> 'Sin asignar'
    UNION
    SELECT DISTINCT destination_department FROM tickets WHERE destination_department IS NOT NULL
    ORDER BY 1`;
  res.json(rows.map((r) => r.name));
});

operatorRouter.post('/desks/:id/claim', idParam, async (_req, res) => {
  res.json(await claimDesk(res.locals.params.id, me(res)));
});

operatorRouter.post(
  '/desks/:id/release',
  idParam,
  validate({ body: z.object({ force: z.boolean().optional() }) }),
  async (_req, res) => {
    res.json(await releaseDesk(res.locals.params.id, me(res), res.locals.body.force));
  },
);

operatorRouter.get('/desks/:id/state', idParam, async (_req, res) => {
  res.json(await getDeskState(res.locals.params.id, me(res)));
});

/** ★ Llamar siguiente — FOR UPDATE SKIP LOCKED. 204 si no hay nadie esperando. */
operatorRouter.post('/desks/:id/call-next', idParam, async (_req, res) => {
  const ticket = await callNext(res.locals.params.id, me(res));
  if (!ticket) {
    res.status(204).end();
    return;
  }
  res.json(ticket);
});

operatorRouter.post('/tickets/:id/start', idParam, async (_req, res) => {
  res.json(await startService(res.locals.params.id, me(res)));
});

/** ★ Cierre de atención con resultado de la petición. */
operatorRouter.post('/tickets/:id/finish', idParam, validate({ body: ResolutionSchema }), async (_req, res) => {
  res.json(await finishService(res.locals.params.id, me(res), res.locals.body));
});

operatorRouter.post('/tickets/:id/absent', idParam, async (_req, res) => {
  res.json(await markAbsent(res.locals.params.id, me(res)));
});
operatorRouter.post('/tickets/:id/recall', idParam, async (_req, res) => {
  res.json(await recall(res.locals.params.id, me(res)));
});
operatorRouter.post('/tickets/:id/requeue', idParam, async (_req, res) => {
  res.json(await returnToQueue(res.locals.params.id, me(res)));
});

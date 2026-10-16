import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
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

/** Panel de operador: todos los roles pueden operar un box. */
export const operatorRouter = Router();
operatorRouter.use(requireAuth, requireRole('OPERATOR', 'SUPERVISOR', 'ADMIN'));

const idParam = validate({ params: z.object({ id: z.string().uuid() }) });
const me = (res: { locals: Record<string, unknown> }) => res.locals.user as AuthUser;

/** Boxes de la sucursal del usuario (ADMIN debe indicar ?branchId=). */
operatorRouter.get(
  '/desks',
  validate({ query: z.object({ branchId: z.string().uuid().optional() }) }),
  async (_req, res) => {
    const user = me(res);
    const branchId = res.locals.query.branchId ?? user.branchId;
    if (!branchId) throw badRequest('Indicá branchId');
    assertBranchAccess(user, branchId);
    const desks = await prisma.desk.findMany({
      where: { branchId, isActive: true },
      orderBy: { identifier: 'asc' },
      select: {
        id: true,
        identifier: true,
        currentOperatorId: true,
        currentOperator: { select: { name: true } },
        categories: { select: { category: { select: { name: true, prefixLetter: true } } } },
      },
    });
    res.json(
      desks.map((d) => ({
        id: d.id,
        identifier: d.identifier,
        occupiedBy: d.currentOperator?.name ?? null,
        isMine: d.currentOperatorId === user.sub,
        categories: d.categories.map((c) => `${c.category.prefixLetter} · ${c.category.name}`),
      })),
    );
  },
);

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
operatorRouter.post('/tickets/:id/finish', idParam, async (_req, res) => {
  res.json(await finishService(res.locals.params.id, me(res)));
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

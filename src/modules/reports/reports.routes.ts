import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { assertBranchAccess, requireAuth, requireRole, type AuthUser } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { businessDate } from '../../lib/time.js';
import { buildWhere, exportCsv, filterOptions, listAttentions, ReportFilterSchema, summarize } from './reports.service.js';

/**
 * Reportería ministerial (SUPERVISOR y ADMIN).
 *
 *   GET /api/reports/attentions   listado paginado (o CSV con ?format=csv)
 *   GET /api/reports/summary      totales y desgloses por motivo, Dirección,
 *                                 taquilla, funcionario, hora, día y resultado
 *   GET /api/reports/options      valores para los selectores de filtros
 *
 * Filtros (query, combinables): from, to, year, month, day, dayOfWeek, hour,
 * deskId, deskNumber, operatorId, reasonId, department, status,
 * resolutionStatus, type, preferential, idOrigin, idNumber, name, branchId.
 */
export const reportsRouter = Router();
reportsRouter.use(requireAuth, requireRole('SUPERVISOR', 'ADMIN'));

const me = (res: { locals: Record<string, unknown> }) => res.locals.user as AuthUser;

const ListQuery = ReportFilterSchema.and(
  z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
    format: z.enum(['json', 'csv']).default('json'),
  }),
);

reportsRouter.get('/attentions', validate({ query: ListQuery }), async (_req, res) => {
  const { page, pageSize, format, ...filters } = res.locals.query;
  const where = buildWhere(filters, me(res));
  if (format === 'csv') {
    res
      .type('text/csv; charset=utf-8')
      .attachment(`atenciones_${businessDate()}.csv`)
      .send(await exportCsv(where, env.APP_TIMEZONE));
    return;
  }
  res.json(await listAttentions(where, page, pageSize));
});

reportsRouter.get('/summary', validate({ query: ReportFilterSchema }), async (_req, res) => {
  res.json(await summarize(buildWhere(res.locals.query, me(res))));
});

reportsRouter.get(
  '/options',
  validate({ query: z.object({ branchId: z.string().uuid().optional() }) }),
  async (_req, res) => {
    const user = me(res);
    const branchId = user.role === 'ADMIN' ? res.locals.query.branchId : user.branchId!;
    if (branchId) assertBranchAccess(user, branchId);
    res.json(await filterOptions(branchId));
  },
);

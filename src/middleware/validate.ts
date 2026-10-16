import type { RequestHandler } from 'express';
import type { ZodTypeAny, z } from 'zod';

/**
 * Valida body / query / params con Zod. El resultado parseado queda en
 * `res.locals.body`, `res.locals.query` y `res.locals.params`.
 */
export function validate<B extends ZodTypeAny, Q extends ZodTypeAny, P extends ZodTypeAny>(schemas: {
  body?: B;
  query?: Q;
  params?: P;
}): RequestHandler {
  return (req, res, next) => {
    if (schemas.body) res.locals.body = schemas.body.parse(req.body ?? {});
    if (schemas.query) res.locals.query = schemas.query.parse(req.query);
    if (schemas.params) res.locals.params = schemas.params.parse(req.params);
    next();
  };
}

export type Infer<T extends ZodTypeAny> = z.infer<T>;

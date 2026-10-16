import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { HttpError } from '../lib/errors.js';
import { isProd } from '../config/env.js';

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: 'Datos inválidos',
      issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.code, message: err.message });
    return;
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      res.status(409).json({ error: 'DUPLICATE', message: 'Ya existe un registro con esos datos únicos' });
      return;
    }
    if (err.code === 'P2025') {
      res.status(404).json({ error: 'NOT_FOUND', message: 'Recurso no encontrado' });
      return;
    }
  }
  if (err?.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'BAD_JSON', message: 'JSON mal formado' });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'INTERNAL', message: isProd ? 'Error interno' : String(err?.message ?? err) });
};

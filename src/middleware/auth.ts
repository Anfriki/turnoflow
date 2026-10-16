import type { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import type { Role } from '@prisma/client';
import { env } from '../config/env.js';
import { forbidden, unauthorized } from '../lib/errors.js';

export interface AuthUser {
  sub: string;
  name: string;
  email: string;
  role: Role;
  branchId: string | null;
}

export function signToken(user: AuthUser): string {
  return jwt.sign(user, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'] });
}

export function verifyToken(token: string): AuthUser {
  const payload = jwt.verify(token, env.JWT_SECRET) as AuthUser & jwt.JwtPayload;
  return { sub: payload.sub, name: payload.name, email: payload.email, role: payload.role, branchId: payload.branchId };
}

/** Exige un JWT válido en `Authorization: Bearer <token>` y deja el usuario en res.locals.user. */
export const requireAuth: RequestHandler = (req, res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw unauthorized();
  try {
    res.locals.user = verifyToken(header.slice(7));
  } catch {
    throw unauthorized('Token inválido o expirado');
  }
  next();
};

/** Restringe la ruta a ciertos roles. Usar después de requireAuth. */
export const requireRole =
  (...roles: Role[]): RequestHandler =>
  (_req, res, next) => {
    const user = res.locals.user as AuthUser | undefined;
    if (!user) throw unauthorized();
    if (!roles.includes(user.role)) throw forbidden();
    next();
  };

/**
 * Supervisores y operadores sólo pueden operar sobre su propia sucursal.
 * Los ADMIN tienen alcance global.
 */
export function assertBranchAccess(user: AuthUser, branchId: string): void {
  if (user.role === 'ADMIN') return;
  if (user.branchId !== branchId) throw forbidden('No tenés acceso a esta sucursal');
}

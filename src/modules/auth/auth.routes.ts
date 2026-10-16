import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { unauthorized } from '../../lib/errors.js';
import { requireAuth, signToken, type AuthUser } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';

export const authRouter = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'RATE_LIMITED', message: 'Demasiados intentos de ingreso, esperá unos minutos' },
});

// Hash ficticio para igualar el tiempo de respuesta cuando el email no existe.
const DUMMY_HASH = bcrypt.hashSync('timing-safe-dummy', 10);

authRouter.post(
  '/login',
  loginLimiter,
  validate({ body: z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1) }) }),
  async (_req, res) => {
    const { email, password } = res.locals.body;
    const user = await prisma.user.findUnique({ where: { email } });
    const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok || !user.isActive) throw unauthorized('Email o contraseña incorrectos');

    const payload: AuthUser = {
      sub: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      branchId: user.branchId,
    };
    res.json({ token: signToken(payload), user: payload });
  },
);

authRouter.get('/me', requireAuth, async (_req, res) => {
  const me = res.locals.user as AuthUser;
  const desk = await prisma.desk.findUnique({
    where: { currentOperatorId: me.sub },
    select: { id: true, identifier: true, branchId: true },
  });
  res.json({ user: me, desk });
});

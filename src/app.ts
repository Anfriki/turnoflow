import path from 'node:path';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env, isProd } from './config/env.js';
import { brandCss, getBrand } from './config/brand.js';
import { prisma } from './db/prisma.js';
import { errorHandler } from './middleware/error.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { publicRouter } from './modules/public/public.routes.js';
import { operatorRouter } from './modules/operator/operator.routes.js';
import { adminRouter } from './modules/admin/admin.routes.js';

export function createApp() {
  const app = express();
  const publicDir = path.resolve(process.cwd(), 'public');

  app.set('trust proxy', 1); // detrás de Nginx / Render / Railway
  app.disable('x-powered-by');
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          // ws/wss para Socket.io; media para el sonido del llamado
          'connect-src': ["'self'", 'ws:', 'wss:'],
          'media-src': ["'self'", 'data:', 'blob:'],
          'img-src': ["'self'", 'data:'],
          'upgrade-insecure-requests': isProd ? [] : null,
        },
      },
    }),
  );
  if (env.CORS_ORIGINS.length) app.use(cors({ origin: env.CORS_ORIGINS, credentials: true }));
  app.use(express.json({ limit: '100kb' }));

  // ── Marca blanca ──
  app.get('/api/brand', (_req, res) => {
    const b = getBrand();
    res.json({
      companyName: b.companyName,
      tagline: b.tagline,
      locale: b.locale,
      timezone: env.APP_TIMEZONE,
      assets: b.assets,
      display: b.display,
      totem: b.totem,
      appointments: b.appointments,
    });
  });
  app.get('/brand.css', (_req, res) => {
    res.type('text/css').set('Cache-Control', 'no-cache').send(brandCss(getBrand()));
  });

  app.get('/health', async (_req, res) => {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  // ── API ──
  app.use('/api/auth', authRouter);
  app.use('/api/public', publicRouter);
  app.use('/api/operator', operatorRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'NOT_FOUND', message: 'Endpoint inexistente' });
  });

  // ── Frontend (3 vistas: totem.html, operator.html, display.html) ──
  app.use(express.static(publicDir, { extensions: ['html'], maxAge: isProd ? '1h' : 0 }));

  app.use(errorHandler);
  return app;
}

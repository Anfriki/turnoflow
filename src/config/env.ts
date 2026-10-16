import 'dotenv/config';
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL es obligatorio'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET debe tener al menos 32 caracteres'),
  JWT_EXPIRES_IN: z.string().default('12h'),
  APP_TIMEZONE: z
    .string()
    .default('America/Caracas')
    .refine((tz) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, 'APP_TIMEZONE no es una zona horaria IANA válida'),
  /** Emisiones públicas (turnos/citas) por minuto y por IP. Ojo: varios tótems detrás de un NAT comparten IP. */
  RATE_LIMIT_PUBLIC_PER_MIN: z.coerce.number().int().positive().default(120),
  CORS_ORIGINS: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : [])),

  // ── Consulta de cédulas (SAIME / nómina / padrón) ──
  /** mock = datos simulados · http = servicio externo real · none = sólo cache local */
  CITIZEN_LOOKUP_PROVIDER: z.enum(['mock', 'http', 'none']).default('mock'),
  CITIZEN_LOOKUP_URL: z.string().url().optional(),
  CITIZEN_LOOKUP_TOKEN: z.string().optional(),
  CITIZEN_LOOKUP_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),
  /** Días que un nombre obtenido del servicio externo se considera vigente en la cache. */
  CITIZEN_CACHE_TTL_DAYS: z.coerce.number().int().positive().default(180),
  /** En el endpoint PÚBLICO de consulta (tótem), devolver el nombre enmascarado ("M**** G*****"). */
  CITIZEN_LOOKUP_MASK_PUBLIC: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /** Consultas públicas de cédula por minuto y por IP (freno a la enumeración de datos). */
  RATE_LIMIT_LOOKUP_PER_MIN: z.coerce.number().int().positive().default(30),
}).superRefine((e, ctx) => {
  if (e.CITIZEN_LOOKUP_PROVIDER === 'http' && !e.CITIZEN_LOOKUP_URL) {
    ctx.addIssue({ code: 'custom', path: ['CITIZEN_LOOKUP_URL'], message: 'Obligatorio cuando CITIZEN_LOOKUP_PROVIDER=http' });
  }
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('❌ Variables de entorno inválidas:');
  for (const issue of parsed.error.issues) console.error(`   - ${issue.path.join('.')}: ${issue.message}`);
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';

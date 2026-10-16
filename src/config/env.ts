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
    .default('America/Argentina/Buenos_Aires')
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
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('❌ Variables de entorno inválidas:');
  for (const issue of parsed.error.issues) console.error(`   - ${issue.path.join('.')}: ${issue.message}`);
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';

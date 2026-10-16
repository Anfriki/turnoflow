import { env } from '../config/env.js';

/** Fecha de negocio actual (YYYY-MM-DD) en APP_TIMEZONE. Base de la numeración diaria. */
export function businessDate(at: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: env.APP_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/** Convierte 'YYYY-MM-DD' al Date que Prisma espera para columnas @db.Date. */
export const toDbDate = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);

/** Día de la semana (0=domingo) de una fecha 'YYYY-MM-DD', independiente de la zona. */
export const weekday = (ymd: string) => new Date(`${ymd}T12:00:00.000Z`).getUTCDay();

/** Diferencia en días calendario entre dos fechas 'YYYY-MM-DD'. */
export const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** Formatea el código visible del turno: A-001, R-042… */
export const formatTicketCode = (prefix: string, n: number) => `${prefix}-${String(n).padStart(3, '0')}`;

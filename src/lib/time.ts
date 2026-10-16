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

const ISO_WEEKDAY: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/**
 * Desglose temporal para reportería (columnas year/month/day/hour/day_of_week).
 * Se calcula en APP_TIMEZONE para que "las 9 de la mañana" sean las 9 locales.
 */
export function temporalParts(at: Date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: env.APP_TIMEZONE,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      hourCycle: 'h23',
      weekday: 'short',
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    dayOfWeek: ISO_WEEKDAY[parts.weekday],
  };
}

/** Segundos enteros entre dos instantes (nunca negativo). */
export const secondsBetween = (from: Date, to: Date) => Math.max(0, Math.round((to.getTime() - from.getTime()) / 1000));

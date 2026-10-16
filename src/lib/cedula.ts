import { z } from 'zod';
import type { IdOrigin } from '@prisma/client';

/**
 * Identificación institucional del ciudadano.
 *   V  Venezolano          cédula de hasta 8 dígitos
 *   E  Extranjero          cédula de hasta 10 dígitos
 *   J  Persona jurídica    RIF: 8 dígitos + dígito verificador
 *   G  Ente gubernamental  RIF: 8 dígitos + dígito verificador
 */
export const ID_ORIGINS = ['V', 'E', 'J', 'G'] as const;

const LENGTH: Record<IdOrigin, [min: number, max: number]> = {
  V: [4, 8],
  E: [4, 10],
  J: [8, 9],
  G: [8, 9],
};

/** Quita puntos, guiones, espacios y ceros a la izquierda: "V-012.345.678" → "12345678". */
export const normalizeIdNumber = (raw: string) => raw.replace(/[^\d]/g, '').replace(/^0+(?=\d)/, '');

export const IdOriginSchema = z.enum(ID_ORIGINS, { message: 'Origen de documento inválido (V, E, J o G)' });

export const IdNumberSchema = z
  .string()
  .trim()
  .transform(normalizeIdNumber)
  .refine((v) => /^\d{4,10}$/.test(v), 'El número de cédula debe tener sólo dígitos (4 a 10)');

export const CitizenNameSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/\s+/g, ' '))
  .refine((v) => v.length >= 3 && v.length <= 150, 'Nombre y apellido: entre 3 y 150 caracteres')
  .refine((v) => /^[\p{L}\p{N}][\p{L}\p{N}\s'.,&()-]*$/u.test(v), 'El nombre contiene caracteres no permitidos');

/** Valida el largo del número según el origen. Usar con `.superRefine(checkCitizenId)`. */
export function checkCitizenId(value: { idOrigin?: IdOrigin; idNumber?: string }, ctx: z.RefinementCtx) {
  if (!value.idOrigin || !value.idNumber) return;
  const [min, max] = LENGTH[value.idOrigin];
  if (value.idNumber.length < min || value.idNumber.length > max) {
    ctx.addIssue({
      code: 'custom',
      path: ['idNumber'],
      message:
        min === max
          ? `Para ${value.idOrigin} el número debe tener ${min} dígitos`
          : `Para ${value.idOrigin} el número debe tener entre ${min} y ${max} dígitos`,
    });
  }
}

/** Agrupa de a 3 desde la derecha: "12345678" → "12.345.678", "12345***" → "12.345.***". */
const thousands = (s: string) => s.replace(/(?=(?:.{3})+$)/g, '.').replace(/^\./, '');

/** "V-12.345.678" · "J-12345678-9" */
export function formatCedula(origin: IdOrigin, number: string): string {
  if ((origin === 'J' || origin === 'G') && number.length === 9) return `${origin}-${number.slice(0, 8)}-${number.slice(8)}`;
  if (origin === 'J' || origin === 'G') return `${origin}-${number}`;
  return `${origin}-${thousands(number)}`;
}

/** "V-12.345.***" — oculta los últimos 3 dígitos. */
export function maskCedula(origin: IdOrigin, number: string): string {
  const keep = Math.max(1, number.length - 3);
  const masked = number.slice(0, keep) + '*'.repeat(number.length - keep);
  if (origin === 'J' || origin === 'G') return `${origin}-${masked}`;
  return `${origin}-${thousands(masked)}`;
}

/** "María José González" → "M**** J*** G*******" */
export const maskName = (name: string) =>
  name
    .split(' ')
    .map((w) => (w.length <= 1 ? w : w[0] + '*'.repeat(w.length - 1)))
    .join(' ');

/** Número legible para la síntesis de voz: "12.345.678". */
export const spokenIdNumber = (number: string) => thousands(number);

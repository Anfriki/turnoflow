import type { IdOrigin } from '@prisma/client';
import { env } from '../../config/env.js';

/**
 * ─────────────────────────────────────────────────────────────
 *  PROVEEDORES DE IDENTIDAD (hook para servicios externos)
 *
 *  Un proveedor sólo debe implementar `lookup()`. Para conectar el
 *  servicio real del organismo (SAIME, nómina, padrón propio…):
 *    1. Configurá CITIZEN_LOOKUP_PROVIDER=http, CITIZEN_LOOKUP_URL y
 *       CITIZEN_LOOKUP_TOKEN en el .env, y adaptá `mapHttpResponse()`
 *       al formato de respuesta de ese servicio; o
 *    2. Escribí tu propio CitizenProvider (p. ej. consulta SQL a la
 *       base de nómina) y registralo en `createProvider()`.
 * ─────────────────────────────────────────────────────────────
 */
export interface CitizenProvider {
  /** Se guarda como `source` en la cache (MOCK, SAIME, NOMINA…). */
  readonly name: string;
  /** Devuelve el nombre completo, o null si el documento no existe. Lanza error si el servicio falla. */
  lookup(idOrigin: IdOrigin, idNumber: string): Promise<{ fullName: string } | null>;
}

// ── 1. Proveedor simulado (desarrollo / demos) ────────────────

/** Registros ficticios. Cualquier otra cédula responde "no encontrado". */
const MOCK_REGISTRY: Record<string, string> = {
  'V-12345678': 'María Alejandra González Pérez',
  'V-87654321': 'José Gregorio Rodríguez Méndez',
  'V-5123456': 'Carmen Elena Silva de Ramírez',
  'V-3456789': 'Luis Alberto Hernández Rojas',
  'V-20111222': 'Andrea Valentina Morales Castillo',
  'V-25888999': 'Carlos Eduardo Pérez Blanco',
  'V-9876543': 'Rosa Margarita Díaz Fernández',
  'V-18555444': 'Daniel Josué Torres Medina',
  'E-84123456': 'Giuseppe Antonio Russo Bianchi',
  'E-81999888': 'Ana Lucía Restrepo Gómez',
  'J-123456789': 'Distribuidora Ejemplo C.A.',
  'G-200000001': 'Alcaldía del Municipio Ejemplo',
};

export class MockCitizenProvider implements CitizenProvider {
  readonly name = 'MOCK';

  async lookup(idOrigin: IdOrigin, idNumber: string) {
    await new Promise((r) => setTimeout(r, 250)); // latencia de red simulada
    const fullName = MOCK_REGISTRY[`${idOrigin}-${idNumber}`];
    return fullName ? { fullName } : null;
  }
}

// ── 2. Proveedor HTTP genérico (servicio real) ────────────────

/**
 * Convierte la respuesta del servicio externo en un nombre completo.
 * ⚠️ ADAPTAR al contrato real del servicio. Se aceptan por defecto:
 *   { nombreCompleto } · { fullName } · { nombres, apellidos }
 *   { primer_nombre, segundo_nombre, primer_apellido, segundo_apellido }
 *   y cualquiera de ellos envuelto en { data: … }.
 */
export function mapHttpResponse(body: unknown): string | null {
  const b = (body && typeof body === 'object' && 'data' in body ? (body as { data: unknown }).data : body) as Record<string, unknown> | null;
  if (!b || typeof b !== 'object') return null;
  const s = (k: string) => (typeof b[k] === 'string' ? (b[k] as string).trim() : '');
  const name =
    s('nombreCompleto') ||
    s('fullName') ||
    s('nombre_completo') ||
    [s('nombres'), s('apellidos')].filter(Boolean).join(' ') ||
    [s('primer_nombre'), s('segundo_nombre'), s('primer_apellido'), s('segundo_apellido')].filter(Boolean).join(' ');
  return name || null;
}

export class HttpCitizenProvider implements CitizenProvider {
  readonly name = 'HTTP';

  constructor(
    private readonly baseUrl: string,
    private readonly token: string | undefined,
    private readonly timeoutMs: number,
  ) {}

  async lookup(idOrigin: IdOrigin, idNumber: string) {
    const url = new URL(this.baseUrl);
    url.searchParams.set('nacionalidad', idOrigin);
    url.searchParams.set('cedula', idNumber);

    const res = await fetch(url, {
      headers: { accept: 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Servicio de identidad respondió ${res.status}`);
    const fullName = mapHttpResponse(await res.json());
    return fullName ? { fullName } : null;
  }
}

/** Selecciona el proveedor según CITIZEN_LOOKUP_PROVIDER. */
export function createProvider(): CitizenProvider | null {
  switch (env.CITIZEN_LOOKUP_PROVIDER) {
    case 'mock':
      return new MockCitizenProvider();
    case 'http':
      return new HttpCitizenProvider(env.CITIZEN_LOOKUP_URL!, env.CITIZEN_LOOKUP_TOKEN, env.CITIZEN_LOOKUP_TIMEOUT_MS);
    case 'none':
      return null;
  }
}

import type { IdOrigin, Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { env } from '../../config/env.js';
import { createProvider, type CitizenProvider } from './citizen-providers.js';

export interface CitizenLookupResult {
  found: boolean;
  idOrigin: IdOrigin;
  idNumber: string;
  fullName: string | null;
  /** CACHE (registro externo vigente), LOCAL (cargado en el tótem), MOCK/HTTP (consulta en vivo) o null. */
  source: string | null;
}

/** Compara nombres ignorando mayúsculas, acentos y espacios extra. */
const sameName = (a: string, b: string) => {
  const n = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').replace(/\s+/g, ' ').trim().toLowerCase();
  return n(a) === n(b);
};

/**
 * ─────────────────────────────────────────────────────────────
 *  citizenLookupService
 *
 *  Orden de resolución:
 *   1. Cache con dato del servicio externo y aún vigente (TTL)  → sin salir a la red
 *   2. Proveedor externo (SAIME / nómina / mock)                → se guarda en cache
 *   3. Cache con dato cargado manualmente (LOCAL) o vencido     → mejor que nada
 *   4. No encontrado → el ciudadano/funcionario escribe el nombre
 *
 *  Si el servicio externo falla o tarda, NUNCA bloquea la emisión del
 *  turno: se registra el error y se sigue con la cache.
 * ─────────────────────────────────────────────────────────────
 */
export function createCitizenLookupService(provider: CitizenProvider | null) {
  const ttlMs = env.CITIZEN_CACHE_TTL_DAYS * 86_400_000;

  return {
    providerName: provider?.name ?? null,

    async lookup(idOrigin: IdOrigin, idNumber: string): Promise<CitizenLookupResult> {
      const key = { idOrigin_idNumber: { idOrigin, idNumber } };
      const cached = await prisma.citizen.findUnique({ where: key });
      const result = (fullName: string | null, source: string | null): CitizenLookupResult => ({
        found: Boolean(fullName),
        idOrigin,
        idNumber,
        fullName,
        source,
      });

      if (cached && cached.source !== 'LOCAL' && Date.now() - cached.updatedAt.getTime() < ttlMs) {
        return result(cached.fullName, 'CACHE');
      }

      if (provider) {
        try {
          const external = await provider.lookup(idOrigin, idNumber);
          if (external) {
            await prisma.citizen.upsert({
              where: key,
              create: { idOrigin, idNumber, fullName: external.fullName, source: provider.name },
              update: { fullName: external.fullName, source: provider.name },
            });
            return result(external.fullName, provider.name);
          }
        } catch (err) {
          console.warn(`[citizen-lookup] ${provider.name} no disponible: ${(err as Error).message}`);
        }
      }

      return cached ? result(cached.fullName, cached.source === 'LOCAL' ? 'LOCAL' : 'CACHE') : result(null, null);
    },

    /**
     * Registra en la cache el nombre confirmado en el tótem / taquilla y la fecha de visita.
     * Si difiere del dato externo (corrección del ciudadano), prevalece lo cargado.
     */
    async remember(idOrigin: IdOrigin, idNumber: string, fullName: string, tx: Prisma.TransactionClient = prisma) {
      const key = { idOrigin_idNumber: { idOrigin, idNumber } };
      const existing = await tx.citizen.findUnique({ where: key });
      const now = new Date();
      if (!existing) {
        await tx.citizen.create({ data: { idOrigin, idNumber, fullName, source: 'LOCAL', lastVisitAt: now } });
      } else if (sameName(existing.fullName, fullName)) {
        await tx.citizen.update({ where: key, data: { lastVisitAt: now, updatedAt: existing.updatedAt } });
      } else {
        await tx.citizen.update({ where: key, data: { fullName, source: 'LOCAL', lastVisitAt: now } });
      }
    },
  };
}

export const citizenLookupService = createCitizenLookupService(createProvider());

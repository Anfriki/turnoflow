import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { z } from 'zod';
import { verifyToken, type AuthUser } from '../middleware/auth.js';
import { getQueueSnapshot, type QueueSnapshot } from '../modules/tickets/queue.service.js';
import type { PublicTicket } from '../modules/tickets/ticket.dto.js';

/**
 * ─────────────────────────────────────────────────────────────
 *  Servicio de tiempo real (Socket.io)
 *
 *  Salas:
 *    branch:<branchId>   → TV de sala, paneles de operador y tótems de esa sucursal
 *    ticket:<ticketId>   → el celular del cliente siguiendo su propio turno
 *
 *  Eventos servidor → cliente:
 *    ticket:called   { ticket, isRecall }   un box llamó a un turno (la TV suena)
 *    ticket:updated  { ticket }             cambio de estado de un turno
 *    queue:updated   QueueSnapshot          estado agregado de la cola
 *
 *  Eventos cliente → servidor (con ack):
 *    branch:join   { branchId }  → { ok, snapshot }
 *    branch:leave  { branchId }
 *    ticket:watch  { ticketId }
 * ─────────────────────────────────────────────────────────────
 */

export interface ServerToClientEvents {
  'ticket:called': (payload: { ticket: PublicTicket; isRecall: boolean }) => void;
  'ticket:updated': (payload: { ticket: PublicTicket }) => void;
  'queue:updated': (snapshot: QueueSnapshot) => void;
}

type Ack = (res: { ok: boolean; error?: string; snapshot?: QueueSnapshot }) => void;

export interface ClientToServerEvents {
  'branch:join': (payload: { branchId: string }, ack?: Ack) => void;
  'branch:leave': (payload: { branchId: string }) => void;
  'ticket:watch': (payload: { ticketId: string }, ack?: Ack) => void;
}

interface SocketData {
  user: AuthUser | null;
}

let io: Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData> | null = null;

const branchRoom = (id: string) => `branch:${id}`;
const ticketRoom = (id: string) => `ticket:${id}`;
const IdPayload = z.object({ branchId: z.string().uuid() });
const TicketPayload = z.object({ ticketId: z.string().uuid() });

export function initSockets(httpServer: HttpServer, corsOrigins: string[]) {
  io = new Server(httpServer, {
    cors: corsOrigins.length ? { origin: corsOrigins, credentials: true } : undefined,
    pingInterval: 20_000,
    pingTimeout: 20_000,
  });

  // Autenticación opcional: la TV y el tótem son públicos; si se envía token, debe ser válido.
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) {
      socket.data.user = null;
      return next();
    }
    try {
      socket.data.user = verifyToken(token);
      next();
    } catch {
      next(new Error('UNAUTHORIZED'));
    }
  });

  io.on('connection', (socket: Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>) => {
    socket.on('branch:join', async (payload, ack) => {
      const parsed = IdPayload.safeParse(payload);
      if (!parsed.success) return ack?.({ ok: false, error: 'branchId inválido' });
      await socket.join(branchRoom(parsed.data.branchId));
      try {
        ack?.({ ok: true, snapshot: await getQueueSnapshot(parsed.data.branchId) });
      } catch (err) {
        console.error('[socket] snapshot error', err);
        ack?.({ ok: false, error: 'No se pudo obtener el estado de la cola' });
      }
    });

    socket.on('branch:leave', (payload) => {
      const parsed = IdPayload.safeParse(payload);
      if (parsed.success) void socket.leave(branchRoom(parsed.data.branchId));
    });

    socket.on('ticket:watch', async (payload, ack) => {
      const parsed = TicketPayload.safeParse(payload);
      if (!parsed.success) return ack?.({ ok: false, error: 'ticketId inválido' });
      await socket.join(ticketRoom(parsed.data.ticketId));
      ack?.({ ok: true });
    });
  });

  return io;
}

// ── Emisores usados por los servicios de negocio ──────────────

const pendingSnapshots = new Map<string, NodeJS.Timeout>();

export const realtime = {
  /** Un box llamó (o re-llamó) a un turno: la TV muestra, suena y anuncia por voz. */
  ticketCalled(ticket: PublicTicket, isRecall = false) {
    io?.to(branchRoom(ticket.branchId)).to(ticketRoom(ticket.id)).emit('ticket:called', { ticket, isRecall });
  },

  ticketUpdated(ticket: PublicTicket) {
    io?.to(branchRoom(ticket.branchId)).to(ticketRoom(ticket.id)).emit('ticket:updated', { ticket });
  },

  /**
   * Recalcula y difunde el snapshot de la cola. Se agrupan (debounce 150 ms)
   * las ráfagas de cambios para no recalcular por cada ticket emitido.
   */
  queueUpdated(branchId: string) {
    if (!io || pendingSnapshots.has(branchId)) return;
    pendingSnapshots.set(
      branchId,
      setTimeout(async () => {
        pendingSnapshots.delete(branchId);
        try {
          io?.to(branchRoom(branchId)).emit('queue:updated', await getQueueSnapshot(branchId));
        } catch (err) {
          console.error('[socket] queue:updated error', err);
        }
      }, 150),
    );
  },
};

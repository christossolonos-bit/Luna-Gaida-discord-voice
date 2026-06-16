import { WebSocketServer, type WebSocket } from 'ws';
import type { Server } from 'node:http';
import { z } from 'zod';
import type { LiveSessionManager } from '../live/liveSession.js';
import { logger } from '../logging/logger.js';

const clientEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('connect') }),
  z.object({ type: z.literal('disconnect') }),
  z.object({ type: z.literal('text'), text: z.string().max(8000) }),
  z.object({ type: z.literal('audio'), data: z.string(), mimeType: z.string().optional() }),
  z.object({ type: z.literal('video'), data: z.string(), mimeType: z.string().optional() }),
  z.object({ type: z.literal('mode'), passive: z.boolean().optional() }),
  z.object({ type: z.literal('interrupt') })
]);

export function attachRealtimeServer(server: Server, live: LiveSessionManager) {
  const wss = new WebSocketServer({ server, path: '/realtime' });
  const sockets = new Set<WebSocket>();
  live.setEmitter((event) => {
    for (const socket of sockets) {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(event));
      }
    }
  });

  wss.on('connection', (socket: WebSocket) => {
    sockets.add(socket);
    socket.send(JSON.stringify({ type: 'status', status: 'offline' }));

    socket.on('message', (raw) => {
      try {
        const parsed = clientEventSchema.parse(JSON.parse(raw.toString()));
        if (parsed.type === 'connect') {
          void live.connect('desktop');
        } else if (parsed.type === 'disconnect') {
          live.close();
        } else {
          void live.handleInput(parsed);
        }
      } catch (error) {
        logger.warn('Rejected realtime client payload', error);
        socket.send(JSON.stringify({ type: 'error', reason: 'invalid_payload' }));
      }
    });

    socket.on('close', () => {
      sockets.delete(socket);
      if (sockets.size === 0) {
        live.close();
      }
    });
  });

  return wss;
}

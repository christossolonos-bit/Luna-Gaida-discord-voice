import { WebSocketServer, type WebSocket } from 'ws';
import type { Server } from 'node:http';
import { z } from 'zod';
import type { LiveSessionManager, LiveSurface } from '../live/liveSession.js';
import { logger } from '../logging/logger.js';

const realtimeSurfaceSchema = z.enum(['app', 'browser']).optional();
const clientEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('connect'), surface: realtimeSurfaceSchema }),
  z.object({ type: z.literal('disconnect') }),
  z.object({ type: z.literal('text'), text: z.string().max(8000), requestId: z.string().uuid().optional() }),
  z.object({ type: z.literal('audio'), data: z.string(), mimeType: z.string().optional() }),
  z.object({ type: z.literal('video'), data: z.string(), mimeType: z.string().optional() }),
  z.object({ type: z.literal('screen.start') }),
  z.object({ type: z.literal('screen.stop') }),
  z.object({ type: z.literal('mode'), passive: z.boolean().optional() }),
  z.object({ type: z.literal('interrupt') })
]);

type RealtimeContext = 'app' | 'browser';

export function attachRealtimeServer(server: Server, createLive: (context: RealtimeContext) => LiveSessionManager) {
  const wss = new WebSocketServer({ server, path: '/realtime' });
  const sockets = new Map<WebSocket, RealtimeContext>();
  const liveContexts = new Map<RealtimeContext, LiveSessionManager>();

  const getLive = (context: RealtimeContext) => {
    let live = liveContexts.get(context);
    if (!live) {
      live = createLive(context);
      live.setEmitter((event) => {
        for (const [socket, socketContext] of sockets) {
          if (socketContext !== context) {
            continue;
          }
          if (socket.readyState === socket.OPEN) {
            socket.send(JSON.stringify(event));
          }
        }
      });
      liveContexts.set(context, live);
    }
    return live;
  };

  const closeContextIfIdle = (context: RealtimeContext) => {
    for (const socketContext of sockets.values()) {
      if (socketContext === context) {
        return;
      }
    }
    liveContexts.get(context)?.close();
  };

  const sendStatus = (context: RealtimeContext) => {
    getLive(context).emitCurrentStatus();
  };

  wss.on('connection', (socket: WebSocket) => {
    let context: RealtimeContext = 'app';
    sockets.set(socket, context);
    sendStatus(context);

    socket.on('message', (raw) => {
      try {
        const parsed = clientEventSchema.parse(JSON.parse(raw.toString()));
        if (parsed.type === 'connect') {
          const nextContext = parsed.surface ?? 'app';
          if (nextContext !== context) {
            const previousContext = context;
            context = nextContext;
            sockets.set(socket, context);
            closeContextIfIdle(previousContext);
            sendStatus(context);
          }
          void getLive(context).connect(toLiveSurface(context));
        } else if (parsed.type === 'disconnect') {
          getLive(context).close();
        } else {
          if (parsed.type === 'text' && parsed.requestId && socket.readyState === socket.OPEN) {
            socket.send(JSON.stringify({
              type: 'input.ack',
              requestId: parsed.requestId,
              inputType: 'text'
            }));
          }
          void getLive(context).handleInput(parsed, toLiveSurface(context)).catch((error) => {
            logger.warn('Realtime input handling failed', {
              context,
              type: parsed.type,
              error: error instanceof Error ? error.message : String(error)
            });
            if (socket.readyState === socket.OPEN) {
              socket.send(JSON.stringify({
                type: 'status',
                status: 'error',
                reason: error instanceof Error ? error.message : String(error)
              }));
            }
          });
        }
      } catch (error) {
        logger.warn('Rejected realtime client payload', error);
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify({ type: 'error', reason: 'invalid_payload' }));
        }
      }
    });

    socket.on('close', () => {
      sockets.delete(socket);
      closeContextIfIdle(context);
    });
  });

  return wss;
}

function toLiveSurface(context: RealtimeContext): LiveSurface {
  return context === 'browser' ? 'browser' : 'desktop';
}

import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage, Server } from 'node:http';
import { z } from 'zod';
import type { LiveSurface } from '../live/liveSession.js';
import type { LiveClientEvent, LiveInputEvent } from '../live/liveSession.js';
import { logger } from '../logging/logger.js';
import { isLunaElectronAudioMuted } from '../live/lunaTtsOutput.js';
import { setAvatarBroadcaster } from './avatarBroadcast.js';

const realtimeSurfaceSchema = z.enum(['app', 'browser']).optional();
const clientEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('connect'),
    surface: realtimeSurfaceSchema,
    role: z.enum(['avatar', 'monitor', 'live']).optional()
  }),
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

export interface RealtimeSession {
  setEmitter(emit: (event: LiveClientEvent) => void): void;
  emitCurrentStatus(): void;
  connect(surface?: LiveSurface): Promise<void>;
  handleInput(input: LiveInputEvent, surface?: LiveSurface): Promise<void>;
  close(): void;
  dispose(): void;
  setVoiceChangerProfile?(profile: { enabled: boolean; name: string; ffmpegFilter: string }): void;
}

export function attachRealtimeServer(
  server: Server,
  createLive: (context: RealtimeContext) => RealtimeSession,
  options: { createBrowserLive?: ((request: IncomingMessage, guildId: string) => Promise<RealtimeSession | null>) | undefined } = {}
) {
  const wss = new WebSocketServer({ server, path: '/realtime' });
  const sockets = new Map<WebSocket, RealtimeContext>();
  const avatarOnlySockets = new Set<WebSocket>();
  const liveContexts = new Map<RealtimeContext, RealtimeSession>();
  const browserLive = new Map<WebSocket, RealtimeSession>();

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
    liveContexts.get(context)?.dispose();
  };

  const sendStatus = (context: RealtimeContext) => {
    getLive(context).emitCurrentStatus();
  };

  const broadcastAvatarToApp = (event: Extract<LiveClientEvent, {
    type: 'avatar.state' | 'avatar.expression' | 'avatar.local_audio' | 'avatar.model.change' | 'avatar.lipsync' | 'audio' | 'transcript';
  }>) => {
    for (const [socket, socketContext] of sockets) {
      if (socketContext !== 'app') continue;
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(event));
      }
    }
  };
  setAvatarBroadcaster(broadcastAvatarToApp);

  wss.on('connection', async (socket: WebSocket, request: IncomingMessage) => {
    let heartbeatAlive = true;
    const heartbeat = setInterval(() => {
      if (!heartbeatAlive) {
        socket.terminate();
        return;
      }
      heartbeatAlive = false;
      socket.ping();
    }, 25_000);
    heartbeat.unref();
    socket.on('pong', () => { heartbeatAlive = true; });
    const url = new URL(request.url ?? '/realtime', `http://${request.headers.host ?? 'localhost'}`);
    let context: RealtimeContext = url.searchParams.get('surface') === 'browser' ? 'browser' : 'app';
    const initialContext = context;
    if (context === 'app' && !isLoopbackAddress(request.socket.remoteAddress)) {
      clearInterval(heartbeat);
      socket.close(1008, 'local_app_connection_required');
      return;
    }
    if (context === 'browser') {
      const guildId = url.searchParams.get('guildId');
      let live: RealtimeSession | null = null;
      try {
        live = guildId && options.createBrowserLive ? await options.createBrowserLive(request, guildId) : null;
      } catch (error) {
        logger.warn('Could not initialize browser realtime session', {
          guildId,
          error: error instanceof Error ? error.message : String(error)
        });
        clearInterval(heartbeat);
        socket.close(1011, 'browser_session_initialization_failed');
        return;
      }
      if (!live) {
        clearInterval(heartbeat);
        socket.close(1008, 'browser_authentication_or_plan_required');
        return;
      }
      browserLive.set(socket, live);
      live.setEmitter((event) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
      });
    }
    sockets.set(socket, context);
    const currentLive = () => context === 'browser' ? browserLive.get(socket) : getLive(context);

    socket.on('message', (raw) => {
      try {
        const parsed = clientEventSchema.parse(JSON.parse(raw.toString()));
        if (parsed.type === 'connect') {
          const nextContext = parsed.surface ?? 'app';
          if (nextContext !== initialContext) {
            socket.send(JSON.stringify({ type: 'error', reason: 'surface_is_fixed_for_connection' }));
            return;
          }
          if (nextContext === 'browser' && !browserLive.has(socket)) {
            socket.send(JSON.stringify({ type: 'error', reason: 'reconnect_with_authenticated_guild' }));
            return;
          }
          if (nextContext !== context) {
            const previousContext = context;
            context = nextContext;
            sockets.set(socket, context);
            closeContextIfIdle(previousContext);
          }

          const avatarOnly = parsed.role === 'avatar' || parsed.role === 'monitor';
          if (avatarOnly) {
            avatarOnlySockets.add(socket);
            const syncReason = parsed.role === 'monitor' ? 'monitor_sync' : 'avatar_sync';
            socket.send(JSON.stringify({ type: 'status', status: 'connected', reason: syncReason }));
            socket.send(JSON.stringify({ type: 'avatar.state', payload: { state: 'idle' } }));
            if (isLunaElectronAudioMuted()) {
              socket.send(JSON.stringify({ type: 'avatar.local_audio', payload: { muted: true } }));
            }
            return;
          }

          avatarOnlySockets.delete(socket);
          currentLive()?.emitCurrentStatus();
          void currentLive()?.connect(toLiveSurface(context));
        } else if (parsed.type === 'disconnect') {
          if (!avatarOnlySockets.has(socket)) {
            currentLive()?.close();
          }
        } else if (avatarOnlySockets.has(socket)) {
          // Avatar shell only listens for Luna voice state — no Gemini live input.
          return;
        } else {
          if (parsed.type === 'text' && parsed.requestId && socket.readyState === socket.OPEN) {
            socket.send(JSON.stringify({
              type: 'input.ack',
              requestId: parsed.requestId,
              inputType: 'text'
            }));
          }
          void currentLive()?.handleInput(parsed, toLiveSurface(context)).catch((error) => {
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
      clearInterval(heartbeat);
      avatarOnlySockets.delete(socket);
      sockets.delete(socket);
      browserLive.get(socket)?.dispose();
      browserLive.delete(socket);
      closeContextIfIdle(context);
    });
  });

  return wss;
}

function toLiveSurface(context: RealtimeContext): LiveSurface {
  return context === 'browser' ? 'browser' : 'desktop';
}

function isLoopbackAddress(value: string | undefined) {
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1';
}

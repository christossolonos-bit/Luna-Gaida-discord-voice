import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listActivity, subscribeActivity } from './activityFeed.js';
import type { UserVoiceMemoryStore } from '../memory/userVoiceMemory.js';

const here = dirname(fileURLToPath(import.meta.url));

function monitorDir() {
  const candidates = [
    resolve(here, '../../monitor'),
    resolve(process.cwd(), 'apps/server/monitor'),
    resolve(process.cwd(), 'monitor')
  ];
  return candidates.find((path) => {
    try { readFileSync(resolve(path, 'monitor.html')); return true; } catch { return false; }
  }) ?? candidates[0]!;
}

export interface MonitorPttHandlers {
  defaultUserId?: string | undefined;
  startPtt: (userId: string) => { ok: boolean; message?: string };
  stopPtt: (userId: string) => { ok: boolean; message?: string };
}

export async function registerMonitorRoutes(
  app: FastifyInstance,
  getDiscordStatus: () => unknown,
  ptt?: MonitorPttHandlers,
  voiceMemory?: UserVoiceMemoryStore
) {
  const dir = monitorDir();

  const noCache = { 'Cache-Control': 'no-cache, no-store, must-revalidate' };

  app.get('/monitor', async (_request, reply) => {
    reply.headers(noCache);
    reply.type('text/html').send(readFileSync(resolve(dir, 'monitor.html'), 'utf8'));
  });

  app.get('/monitor/style.css', async (_request, reply) => {
    reply.headers(noCache);
    reply.type('text/css').send(readFileSync(resolve(dir, 'monitor.css'), 'utf8'));
  });

  app.get('/monitor/app.js', async (_request, reply) => {
    reply.headers(noCache);
    reply.type('application/javascript').send(readFileSync(resolve(dir, 'monitor.js'), 'utf8'));
  });

  app.get('/monitor/events', async (request, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    res.write(`data: ${JSON.stringify({ type: 'snapshot', events: listActivity(80) })}\n\n`);

    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, 20_000);

    const unsubscribe = subscribeActivity((event) => {
      res.write(`data: ${JSON.stringify({ type: 'event', event })}\n\n`);
    });

    request.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    });
  });

  app.get('/monitor/status', async () => ({
    time: new Date().toISOString(),
    discord: getDiscordStatus(),
    recent: listActivity(20),
    pttAvailable: Boolean(ptt),
    voiceMemory: voiceMemory?.listAll(20).map((record) => ({
      displayName: record.displayName,
      userId: record.userId,
      guildId: record.guildId,
      summary: record.summary,
      updatedAt: record.updatedAt
    })) ?? []
  }));

  app.get('/monitor/memory', async () => ({
    users: voiceMemory?.listAll(50).map((record) => ({
      displayName: record.displayName,
      userId: record.userId,
      guildId: record.guildId,
      summary: record.summary,
      updatedAt: record.updatedAt
    })) ?? []
  }));

  if (ptt) {
    app.post('/monitor/ptt/start', async (request) => {
      const body = (request.body ?? {}) as { userId?: string };
      const userId = body.userId?.trim() || ptt.defaultUserId;
      if (!userId) {
        return { ok: false, message: 'No Discord user id configured for monitor PTT.' };
      }
      return ptt.startPtt(userId);
    });

    app.post('/monitor/ptt/stop', async (request) => {
      const body = (request.body ?? {}) as { userId?: string };
      const userId = body.userId?.trim() || ptt.defaultUserId;
      if (!userId) {
        return { ok: false, message: 'No Discord user id configured for monitor PTT.' };
      }
      return ptt.stopPtt(userId);
    });
  }
}

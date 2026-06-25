import { EventEmitter } from 'node:events';

export type ActivityLevel = 'info' | 'success' | 'warn' | 'error' | 'user' | 'assistant';

export interface ActivityEvent {
  id: number;
  time: string;
  level: ActivityLevel;
  title: string;
  detail?: string;
  meta?: Record<string, unknown>;
}

const MAX_EVENTS = 200;
const listeners = new Set<(event: ActivityEvent) => void>();
let nextId = 1;
const events: ActivityEvent[] = [];

export function publishActivity(input: {
  level: ActivityLevel;
  title: string;
  detail?: string;
  meta?: Record<string, unknown>;
}) {
  const event: ActivityEvent = {
    id: nextId++,
    time: new Date().toISOString(),
    level: input.level,
    title: input.title,
    ...(input.detail ? { detail: input.detail } : {}),
    ...(input.meta ? { meta: input.meta } : {})
  };
  events.push(event);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  for (const listener of listeners) listener(event);
  return event;
}

export function listActivity(limit = 50) {
  return events.slice(-limit);
}

export function subscribeActivity(listener: (event: ActivityEvent) => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function formatLoggerActivity(level: 'info' | 'warn' | 'error' | 'debug', message: string, meta: unknown) {
  const record = meta && typeof meta === 'object' ? meta as Record<string, unknown> : {};
  const mapped = mapKnownLog(message, record);
  if (!mapped) return;
  publishActivity({
    level: mapped.level,
    title: mapped.title,
    ...(mapped.detail ? { detail: mapped.detail } : {}),
    meta: record
  });
}

function mapKnownLog(message: string, meta: Record<string, unknown>) {
  if (message === 'Discord bot ready') {
    const user = typeof meta.user === 'string' ? meta.user : 'Luna';
    return { level: 'success' as const, title: `${user} is online`, detail: `${meta.guilds ?? 0} server(s) connected` };
  }
  if (message === 'Local voice transcribed user speech') {
    return { level: 'user' as const, title: 'You said', detail: String(meta.transcript ?? '') };
  }
  if (message === 'Local voice generated reply') {
    return null;
  }
  if (message === 'Local voice playing full TTS clip') {
    const durationMs = typeof meta.durationMs === 'number' ? Math.max(0, meta.durationMs) : 0;
    return { level: 'assistant' as const, title: 'Luna is speaking', detail: durationMs ? `~${(durationMs / 1000).toFixed(1)}s` : undefined };
  }
  if (message === 'Local voice turn failed') {
    return { level: 'error' as const, title: 'Voice turn failed', detail: String(meta.error ?? 'unknown error') };
  }
  if (message === 'Local voice worker ready') {
    return { level: 'success' as const, title: 'Voice engine ready', detail: `Whisper + XTTS on ${meta.device ?? 'cpu'}` };
  }
  if (message === 'Received Discord slash command') {
    const sub = meta.subcommand ? ` /${meta.subcommand}` : '';
    return { level: 'info' as const, title: `Slash command /giada${sub}`, detail: meta.guildId ? `guild ${meta.guildId}` : undefined };
  }
  if (message === 'Discord text responder produced no Discord reply') {
    return { level: 'warn' as const, title: 'No text reply sent', detail: 'Check model or quota' };
  }
  if (message === 'Discord plugin disabled: login failed. Check DISCORD_BOT_TOKEN.') {
    return { level: 'error' as const, title: 'Discord login failed', detail: String(meta.meta ?? meta) };
  }
  if (message.startsWith('Discord plugin disabled')) {
    return { level: 'error' as const, title: 'Discord offline', detail: message };
  }
  return null;
}

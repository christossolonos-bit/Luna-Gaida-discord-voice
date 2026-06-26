import type { LiveClientEvent } from '../live/liveSession.js';

type AvatarEvent = Extract<LiveClientEvent, { type: 'avatar.state' | 'avatar.expression' | 'avatar.model.change' | 'avatar.lipsync' }>;

let broadcastToApp: ((event: AvatarEvent) => void) | null = null;

export function setAvatarBroadcaster(fn: (event: AvatarEvent) => void) {
  broadcastToApp = fn;
}

export function broadcastAvatarEvent(event: LiveClientEvent) {
  if (
    event.type !== 'avatar.state'
    && event.type !== 'avatar.expression'
    && event.type !== 'avatar.model.change'
    && event.type !== 'avatar.lipsync'
  ) {
    return;
  }
  broadcastToApp?.(event);
}

import type { LiveClientEvent } from '../live/liveSession.js';

type AvatarEvent = Extract<LiveClientEvent, {
  type: 'avatar.state' | 'avatar.expression' | 'avatar.wardrobe' | 'avatar.local_audio' | 'avatar.model.change' | 'avatar.lipsync' | 'audio' | 'transcript';
}>;

let broadcastToApp: ((event: AvatarEvent) => void) | null = null;

export function setAvatarBroadcaster(fn: (event: AvatarEvent) => void) {
  broadcastToApp = fn;
}

export function broadcastAvatarEvent(event: LiveClientEvent) {
  if (
    event.type !== 'avatar.state'
    && event.type !== 'avatar.expression'
    && event.type !== 'avatar.wardrobe'
    && event.type !== 'avatar.model.change'
    && event.type !== 'avatar.lipsync'
    && event.type !== 'avatar.local_audio'
    && event.type !== 'audio'
    && event.type !== 'transcript'
  ) {
    return;
  }
  broadcastToApp?.(event);
}

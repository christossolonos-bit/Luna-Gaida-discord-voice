import Database from 'better-sqlite3';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

export interface DiscordGuildSettings {
  guildId: string;
  listeningChannelId: string | null;
  voiceWatchChannelId: string | null;
}

interface DiscordSettingsRow {
  guild_id: string;
  listening_channel_id: string | null;
  voice_watch_channel_id: string | null;
}

export class DiscordSettingsStore {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    const resolved = resolve(databasePath);
    mkdirSync(dirname(resolved), { recursive: true });
    this.db = new Database(resolved);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS discord_guild_settings (
        guild_id TEXT PRIMARY KEY,
        listening_channel_id TEXT,
        voice_watch_channel_id TEXT,
        updated_at TEXT NOT NULL
      );
    `);
  }

  get(guildId: string): DiscordGuildSettings {
    const row = this.db.prepare('SELECT * FROM discord_guild_settings WHERE guild_id = ?').get(guildId) as DiscordSettingsRow | undefined;
    if (!row) {
      return { guildId, listeningChannelId: null, voiceWatchChannelId: null };
    }
    return {
      guildId: row.guild_id,
      listeningChannelId: row.listening_channel_id,
      voiceWatchChannelId: row.voice_watch_channel_id
    };
  }

  setListeningChannel(guildId: string, channelId: string | null) {
    this.upsert(guildId, { listeningChannelId: channelId });
  }

  setVoiceWatchChannel(guildId: string, channelId: string | null) {
    this.upsert(guildId, { voiceWatchChannelId: channelId });
  }

  private upsert(guildId: string, patch: { listeningChannelId?: string | null; voiceWatchChannelId?: string | null }) {
    const current = this.get(guildId);
    const next = {
      guildId,
      listeningChannelId: patch.listeningChannelId !== undefined ? patch.listeningChannelId : current.listeningChannelId,
      voiceWatchChannelId: patch.voiceWatchChannelId !== undefined ? patch.voiceWatchChannelId : current.voiceWatchChannelId,
      updatedAt: new Date().toISOString()
    };

    this.db.prepare(`
      INSERT INTO discord_guild_settings (guild_id, listening_channel_id, voice_watch_channel_id, updated_at)
      VALUES (@guildId, @listeningChannelId, @voiceWatchChannelId, @updatedAt)
      ON CONFLICT(guild_id) DO UPDATE SET
        listening_channel_id = excluded.listening_channel_id,
        voice_watch_channel_id = excluded.voice_watch_channel_id,
        updated_at = excluded.updated_at
    `).run(next);
  }
}

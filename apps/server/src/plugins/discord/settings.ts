import Database from 'better-sqlite3';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

export interface DiscordGuildSettings {
  guildId: string;
  listeningChannelId: string | null;
  voiceWatchChannelId: string | null;
}

export interface DiscordUserIdentity {
  guildId: string;
  userId: string;
  username: string;
  displayName: string;
  updatedAt: string;
}

interface DiscordSettingsRow {
  guild_id: string;
  listening_channel_id: string | null;
  voice_watch_channel_id: string | null;
}

interface DiscordUserIdentityRow {
  guild_id: string;
  user_id: string;
  username: string;
  display_name: string;
  updated_at: string;
}

interface DiscordAuthorizedUserRow {
  guild_id: string;
  user_id: string;
  authorized_by: string;
  updated_at: string;
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
      CREATE TABLE IF NOT EXISTS discord_user_identities (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        username TEXT NOT NULL,
        display_name TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (guild_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS discord_authorized_users (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        authorized_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (guild_id, user_id)
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

  upsertUserIdentity(input: Omit<DiscordUserIdentity, 'updatedAt'>) {
    const updatedAt = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO discord_user_identities (guild_id, user_id, username, display_name, updated_at)
      VALUES (@guildId, @userId, @username, @displayName, @updatedAt)
      ON CONFLICT(guild_id, user_id) DO UPDATE SET
        username = excluded.username,
        display_name = excluded.display_name,
        updated_at = excluded.updated_at
    `).run({ ...input, updatedAt });
  }

  listUserIdentities(guildId: string, limit = 80): DiscordUserIdentity[] {
    const rows = this.db.prepare(`
      SELECT * FROM discord_user_identities
      WHERE guild_id = ?
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(guildId, Math.min(Math.max(limit, 1), 200)) as DiscordUserIdentityRow[];
    return rows.map((row) => ({
      guildId: row.guild_id,
      userId: row.user_id,
      username: row.username,
      displayName: row.display_name,
      updatedAt: row.updated_at
    }));
  }

  authorizeUser(guildId: string, userId: string, authorizedBy: string) {
    this.db.prepare(`
      INSERT INTO discord_authorized_users (guild_id, user_id, authorized_by, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(guild_id, user_id) DO UPDATE SET
        authorized_by = excluded.authorized_by,
        updated_at = excluded.updated_at
    `).run(guildId, userId, authorizedBy, new Date().toISOString());
  }

  deauthorizeUser(guildId: string, userId: string) {
    this.db.prepare('DELETE FROM discord_authorized_users WHERE guild_id = ? AND user_id = ?').run(guildId, userId);
  }

  isUserAuthorized(guildId: string, userId: string) {
    const row = this.db.prepare('SELECT 1 FROM discord_authorized_users WHERE guild_id = ? AND user_id = ?').get(guildId, userId);
    return Boolean(row);
  }

  listAuthorizedUsers(guildId: string): Array<{ guildId: string; userId: string; authorizedBy: string; updatedAt: string }> {
    const rows = this.db.prepare(`
      SELECT * FROM discord_authorized_users
      WHERE guild_id = ?
      ORDER BY updated_at DESC
    `).all(guildId) as DiscordAuthorizedUserRow[];
    return rows.map((row) => ({
      guildId: row.guild_id,
      userId: row.user_id,
      authorizedBy: row.authorized_by,
      updatedAt: row.updated_at
    }));
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

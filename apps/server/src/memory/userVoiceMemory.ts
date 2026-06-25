import Database from 'better-sqlite3';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

export interface VoiceUserMemory {
  guildId: string;
  userId: string;
  displayName: string | null;
  summary: string;
  updatedAt: string;
}

interface VoiceUserMemoryRow {
  guild_id: string;
  user_id: string;
  display_name: string | null;
  summary: string;
  updated_at: string;
}

export class UserVoiceMemoryStore {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    const resolved = resolve(databasePath);
    mkdirSync(dirname(resolved), { recursive: true });
    this.db = new Database(resolved);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS luna_voice_user_memory (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        display_name TEXT,
        summary TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL,
        PRIMARY KEY (guild_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_luna_voice_user_memory_updated
        ON luna_voice_user_memory(guild_id, updated_at DESC);
    `);
  }

  get(guildId: string, userId: string): VoiceUserMemory | null {
    const row = this.db.prepare(`
      SELECT guild_id, user_id, display_name, summary, updated_at
      FROM luna_voice_user_memory
      WHERE guild_id = ? AND user_id = ?
    `).get(guildId, userId) as VoiceUserMemoryRow | undefined;
    return row ? mapRow(row) : null;
  }

  save(guildId: string, userId: string, displayName: string | null, summary: string) {
    const normalized = normalizeBulletSummary(summary);
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO luna_voice_user_memory (guild_id, user_id, display_name, summary, updated_at)
      VALUES (@guildId, @userId, @displayName, @summary, @updatedAt)
      ON CONFLICT(guild_id, user_id) DO UPDATE SET
        display_name = excluded.display_name,
        summary = excluded.summary,
        updated_at = excluded.updated_at
    `).run({
      guildId,
      userId,
      displayName,
      summary: normalized,
      updatedAt: now
    });
    return normalized;
  }

  listForGuild(guildId: string, limit = 50): VoiceUserMemory[] {
    const rows = this.db.prepare(`
      SELECT guild_id, user_id, display_name, summary, updated_at
      FROM luna_voice_user_memory
      WHERE guild_id = ?
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(guildId, limit) as VoiceUserMemoryRow[];
    return rows.map(mapRow);
  }
}

export function normalizeBulletSummary(text: string, maxBullets = 8, maxWordsPerBullet = 14) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const bullets = lines
    .map((line) => line.replace(/^[-*•]\s*/, '').trim())
    .filter(Boolean)
    .map((line) => {
      const words = line.split(/\s+/).slice(0, maxWordsPerBullet);
      return words.join(' ');
    })
    .filter(Boolean);
  const unique: string[] = [];
  for (const bullet of bullets) {
    const key = bullet.toLowerCase();
    if (!unique.some((existing) => existing.toLowerCase() === key)) {
      unique.push(bullet);
    }
  }
  return unique.slice(0, maxBullets).map((bullet) => `- ${bullet}`).join('\n');
}

function mapRow(row: VoiceUserMemoryRow): VoiceUserMemory {
  return {
    guildId: row.guild_id,
    userId: row.user_id,
    displayName: row.display_name,
    summary: row.summary,
    updatedAt: row.updated_at
  };
}

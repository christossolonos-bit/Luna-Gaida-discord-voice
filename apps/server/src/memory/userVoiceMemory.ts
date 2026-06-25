import Database from 'better-sqlite3';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface VoiceUserMemory {
  guildId: string;
  userId: string;
  displayName: string | null;
  summary: string;
  relationship: string;
  updatedAt: string;
}

interface VoiceUserMemoryRow {
  guild_id: string;
  user_id: string;
  display_name: string | null;
  summary: string;
  relationship: string;
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
    this.ensureRelationshipColumn();
    this.importLegacyRowsIfEmpty();
  }

  private ensureRelationshipColumn() {
    const columns = this.db.prepare('PRAGMA table_info(luna_voice_user_memory)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'relationship')) {
      this.db.exec(`ALTER TABLE luna_voice_user_memory ADD COLUMN relationship TEXT NOT NULL DEFAULT ''`);
    }
  }

  /** Older builds stored voice memory under apps/server/data when cwd differed. */
  private importLegacyRowsIfEmpty() {
    const count = (this.db.prepare('SELECT COUNT(*) AS count FROM luna_voice_user_memory').get() as { count: number }).count;
    if (count > 0) return;

    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const legacyPath = resolve(moduleDir, '../../../data/giada.sqlite');
    if (!existsSync(legacyPath) || resolve(legacyPath) === resolve(this.db.name)) return;

    let legacy: Database.Database | null = null;
    try {
      legacy = new Database(legacyPath, { readonly: true });
      const hasTable = legacy.prepare(`
        SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'luna_voice_user_memory'
      `).get();
      if (!hasTable) return;

      const rows = legacy.prepare(`
        SELECT guild_id, user_id, display_name, summary, updated_at
        FROM luna_voice_user_memory
      `).all() as VoiceUserMemoryRow[];
      if (!rows.length) return;

      const insert = this.db.prepare(`
        INSERT INTO luna_voice_user_memory (guild_id, user_id, display_name, summary, updated_at)
        VALUES (@guild_id, @user_id, @display_name, @summary, @updated_at)
      `);
      const importRows = this.db.transaction((batch: VoiceUserMemoryRow[]) => {
        for (const row of batch) insert.run(row);
      });
      importRows(rows);
    } catch {
      // ignore unreadable legacy database
    } finally {
      legacy?.close();
    }
  }

  get(guildId: string, userId: string): VoiceUserMemory | null {
    const row = this.db.prepare(`
      SELECT guild_id, user_id, display_name, summary, relationship, updated_at
      FROM luna_voice_user_memory
      WHERE guild_id = ? AND user_id = ?
    `).get(guildId, userId) as VoiceUserMemoryRow | undefined;
    return row ? mapRow(row) : null;
  }

  save(guildId: string, userId: string, displayName: string | null, summary: string) {
    const normalized = normalizeBulletSummary(summary);
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO luna_voice_user_memory (guild_id, user_id, display_name, summary, relationship, updated_at)
      VALUES (@guildId, @userId, @displayName, @summary, '', @updatedAt)
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

  saveRelationship(guildId: string, userId: string, displayName: string | null, relationship: string) {
    const normalized = normalizeBulletSummary(relationship, 6, 16);
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO luna_voice_user_memory (guild_id, user_id, display_name, summary, relationship, updated_at)
      VALUES (@guildId, @userId, @displayName, '', @relationship, @updatedAt)
      ON CONFLICT(guild_id, user_id) DO UPDATE SET
        display_name = excluded.display_name,
        relationship = excluded.relationship,
        updated_at = excluded.updated_at
    `).run({
      guildId,
      userId,
      displayName,
      relationship: normalized,
      updatedAt: now
    });
    return normalized;
  }

  listForGuild(guildId: string, limit = 50): VoiceUserMemory[] {
    const rows = this.db.prepare(`
      SELECT guild_id, user_id, display_name, summary, relationship, updated_at
      FROM luna_voice_user_memory
      WHERE guild_id = ?
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(guildId, limit) as VoiceUserMemoryRow[];
    return rows.map(mapRow);
  }

  listAll(limit = 100): VoiceUserMemory[] {
    const rows = this.db.prepare(`
      SELECT guild_id, user_id, display_name, summary, relationship, updated_at
      FROM luna_voice_user_memory
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(limit) as VoiceUserMemoryRow[];
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
    relationship: row.relationship ?? '',
    updatedAt: row.updated_at
  };
}

import Database from 'better-sqlite3';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { normalizeBulletSummary } from './userVoiceMemory.js';

export interface LunaLifeRecord {
  guildId: string;
  narrative: string;
  updatedAt: string;
}

interface LunaLifeRow {
  guild_id: string;
  narrative: string;
  updated_at: string;
}

export const lunaLifeBootstrap = [
  '- Lives on her own terms with walks, films, and bad cooking experiments',
  '- Keeps a private inner world shaped by who she meets in voice',
  '- Forms opinions slowly; her days change when someone matters to her'
].map((line) => line).join('\n');

export class LunaLifeStore {
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
      CREATE TABLE IF NOT EXISTS luna_life (
        guild_id TEXT PRIMARY KEY,
        narrative TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      );
    `);
  }

  get(guildId: string): LunaLifeRecord | null {
    const row = this.db.prepare(`
      SELECT guild_id, narrative, updated_at
      FROM luna_life
      WHERE guild_id = ?
    `).get(guildId) as LunaLifeRow | undefined;
    return row ? mapRow(row) : null;
  }

  getNarrative(guildId: string) {
    return this.get(guildId)?.narrative?.trim() || lunaLifeBootstrap;
  }

  save(guildId: string, narrative: string) {
    const normalized = normalizeBulletSummary(narrative, 10, 18);
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO luna_life (guild_id, narrative, updated_at)
      VALUES (@guildId, @narrative, @updatedAt)
      ON CONFLICT(guild_id) DO UPDATE SET
        narrative = excluded.narrative,
        updated_at = excluded.updated_at
    `).run({ guildId, narrative: normalized, updatedAt: now });
    return normalized;
  }

  listAll(limit = 20): LunaLifeRecord[] {
    const rows = this.db.prepare(`
      SELECT guild_id, narrative, updated_at
      FROM luna_life
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(limit) as LunaLifeRow[];
    return rows.map(mapRow);
  }
}

function mapRow(row: LunaLifeRow): LunaLifeRecord {
  return {
    guildId: row.guild_id,
    narrative: row.narrative,
    updatedAt: row.updated_at
  };
}

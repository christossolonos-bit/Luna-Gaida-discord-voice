import Database from 'better-sqlite3';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

export interface LunaDmRecord {
  guildId: string;
  userId: string;
  displayName: string | null;
  message: string;
  reason: string | null;
  sentAt: string;
}

interface LunaDmRow {
  guild_id: string;
  user_id: string;
  display_name: string | null;
  message: string;
  reason: string | null;
  sent_at: string;
}

export class LunaDmStore {
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
      CREATE TABLE IF NOT EXISTS luna_dm_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        display_name TEXT,
        message TEXT NOT NULL,
        reason TEXT,
        sent_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_luna_dm_user_sent
        ON luna_dm_log(user_id, sent_at DESC);
      CREATE INDEX IF NOT EXISTS idx_luna_dm_sent
        ON luna_dm_log(sent_at DESC);
    `);
  }

  lastDmAt(userId: string): string | null {
    const row = this.db.prepare(`
      SELECT sent_at FROM luna_dm_log
      WHERE user_id = ?
      ORDER BY sent_at DESC
      LIMIT 1
    `).get(userId) as { sent_at: string } | undefined;
    return row?.sent_at ?? null;
  }

  countSince(isoTime: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM luna_dm_log WHERE sent_at >= ?
    `).get(isoTime) as { count: number };
    return row.count;
  }

  record(entry: Omit<LunaDmRecord, 'sentAt'> & { sentAt?: string }) {
    const sentAt = entry.sentAt ?? new Date().toISOString();
    this.db.prepare(`
      INSERT INTO luna_dm_log (guild_id, user_id, display_name, message, reason, sent_at)
      VALUES (@guildId, @userId, @displayName, @message, @reason, @sentAt)
    `).run({
      guildId: entry.guildId,
      userId: entry.userId,
      displayName: entry.displayName,
      message: entry.message,
      reason: entry.reason,
      sentAt
    });
    return sentAt;
  }

  recent(limit = 20): LunaDmRecord[] {
    const rows = this.db.prepare(`
      SELECT guild_id, user_id, display_name, message, reason, sent_at
      FROM luna_dm_log
      ORDER BY sent_at DESC
      LIMIT ?
    `).all(limit) as LunaDmRow[];
    return rows.map(mapRow);
  }

  recentDialogue(limit = 16): string[] {
    return this.recent(limit)
      .reverse()
      .map((record) => `${formatDmSpeaker(record)}: ${record.message.trim()}`);
  }

  recentDialogueForUser(userId: string, limit = 10): string[] {
    const rows = this.db.prepare(`
      SELECT guild_id, user_id, display_name, message, reason, sent_at
      FROM luna_dm_log
      WHERE user_id = ?
      ORDER BY sent_at DESC
      LIMIT ?
    `).all(userId, limit) as LunaDmRow[];
    return rows.reverse().map((row) => `${formatDmSpeaker(mapRow(row))}: ${row.message.trim()}`);
  }
}

function formatDmSpeaker(record: LunaDmRecord) {
  if (record.reason === 'inbound reply' || record.reason === 'outbound' || record.reason === 'autonomous') {
    return 'Luna';
  }
  return record.displayName ?? 'Them';
}

function mapRow(row: LunaDmRow): LunaDmRecord {
  return {
    guildId: row.guild_id,
    userId: row.user_id,
    displayName: row.display_name,
    message: row.message,
    reason: row.reason,
    sentAt: row.sent_at
  };
}

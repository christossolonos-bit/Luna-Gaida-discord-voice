import Database from 'better-sqlite3';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { nanoid } from 'nanoid';
import type { MemoryRecord, MemoryWriteInput, PrivacyClass } from './types.js';

interface MemoryRow {
  id: string;
  content: string;
  summary: string | null;
  tags: string;
  source: MemoryRecord['source'];
  privacy: PrivacyClass;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
}

export class MemoryRepository {
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
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        summary TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        source TEXT NOT NULL CHECK (source IN ('desktop', 'discord', 'system')),
        privacy TEXT NOT NULL CHECK (privacy IN ('public', 'private', 'secret')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_memories_privacy ON memories(privacy);
      CREATE INDEX IF NOT EXISTS idx_memories_source ON memories(source);
    `);
  }

  write(input: MemoryWriteInput): MemoryRecord {
    const now = new Date();
    const expiresAt = input.retentionDays && input.retentionDays > 0
      ? new Date(now.getTime() + input.retentionDays * 24 * 60 * 60 * 1000).toISOString()
      : null;
    const record: MemoryRecord = {
      id: nanoid(),
      content: input.content.trim(),
      summary: null,
      tags: input.tags ?? [],
      source: input.source,
      privacy: input.privacy,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt
    };

    this.db.prepare(`
      INSERT INTO memories (id, content, summary, tags, source, privacy, created_at, updated_at, expires_at)
      VALUES (@id, @content, @summary, @tags, @source, @privacy, @createdAt, @updatedAt, @expiresAt)
    `).run({ ...record, tags: JSON.stringify(record.tags) });

    return record;
  }

  search(query: string, options: { allowPrivate: boolean; limit?: number }): MemoryRecord[] {
    const limit = Math.min(Math.max(options.limit ?? 12, 1), 50);
    const privacyFilter = options.allowPrivate ? "privacy IN ('public', 'private')" : "privacy = 'public'";
    const rows = this.db.prepare(`
      SELECT * FROM memories
      WHERE ${privacyFilter}
        AND (expires_at IS NULL OR expires_at > @now)
        AND (content LIKE @query OR tags LIKE @query OR summary LIKE @query)
      ORDER BY updated_at DESC
      LIMIT @limit
    `).all({ query: `%${query}%`, now: new Date().toISOString(), limit }) as MemoryRow[];
    return rows.map(mapRow);
  }

  listForContext(surface: 'desktop' | 'discord', limit = 20): MemoryRecord[] {
    const privacyFilter = surface === 'discord' ? "privacy = 'public'" : "privacy IN ('public', 'private')";
    const rows = this.db.prepare(`
      SELECT * FROM memories
      WHERE ${privacyFilter}
        AND (expires_at IS NULL OR expires_at > @now)
      ORDER BY updated_at DESC
      LIMIT @limit
    `).all({ now: new Date().toISOString(), limit }) as MemoryRow[];
    return rows.map(mapRow);
  }
}

function mapRow(row: MemoryRow): MemoryRecord {
  return {
    id: row.id,
    content: row.content,
    summary: row.summary,
    tags: JSON.parse(row.tags) as string[],
    source: row.source,
    privacy: row.privacy,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at
  };
}

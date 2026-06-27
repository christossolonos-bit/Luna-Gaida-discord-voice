import Database from 'better-sqlite3';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

export interface LunaResearchRecord {
  id: number;
  source: string;
  mode: string;
  query: string | null;
  url: string | null;
  title: string;
  summary: string;
  createdAt: string;
}

interface LunaResearchRow {
  id: number;
  source: string;
  mode: string;
  query: string | null;
  url: string | null;
  title: string;
  summary: string;
  created_at: string;
}

export class LunaResearchStore {
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
      CREATE TABLE IF NOT EXISTS luna_research (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        mode TEXT NOT NULL,
        query TEXT,
        url TEXT,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_luna_research_created ON luna_research(created_at DESC);
    `);
  }

  record(input: {
    source: string;
    mode: string;
    query?: string | null;
    url?: string | null;
    title: string;
    summary: string;
  }) {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      INSERT INTO luna_research (source, mode, query, url, title, summary, created_at)
      VALUES (@source, @mode, @query, @url, @title, @summary, @createdAt)
    `).run({
      source: input.source,
      mode: input.mode,
      query: input.query ?? null,
      url: input.url ?? null,
      title: input.title.slice(0, 300),
      summary: input.summary.slice(0, 4000),
      createdAt: now
    });
    return Number(result.lastInsertRowid);
  }

  recent(limit = 8): LunaResearchRecord[] {
    const rows = this.db.prepare(`
      SELECT id, source, mode, query, url, title, summary, created_at
      FROM luna_research
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit) as LunaResearchRow[];
    return rows.map(mapRow);
  }

  formatRecentForPrompt(limit = 6) {
    const records = this.recent(limit);
    if (!records.length) return '';
    const lines = records.map((record) => {
      const when = new Date(record.createdAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      return `- [${when}] ${record.title}: ${record.summary.slice(0, 220)}${record.summary.length > 220 ? '…' : ''}`;
    });
    return `Things you recently looked up (use naturally — vary topics, do not fixate on one story):\n${lines.join('\n')}`;
  }

  countSince(iso: string) {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM luna_research
      WHERE created_at >= ?
    `).get(iso) as { count: number };
    return row.count;
  }
}

function mapRow(row: LunaResearchRow): LunaResearchRecord {
  return {
    id: row.id,
    source: row.source,
    mode: row.mode,
    query: row.query,
    url: row.url,
    title: row.title,
    summary: row.summary,
    createdAt: row.created_at
  };
}

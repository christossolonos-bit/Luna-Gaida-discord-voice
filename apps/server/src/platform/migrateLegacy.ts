import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { loadConfig } from '../config/env.js';
import type { MemoryRecord } from '../memory/types.js';
import { createPlatform } from './bootstrap.js';

const config = loadConfig();
const ownerId = config.GIADA_OWNER_DISCORD_USER_ID;
if (!ownerId) throw new Error('GIADA_OWNER_DISCORD_USER_ID is required');
const platform = await createPlatform(config);
if (!platform) throw new Error('GIADA_POSTGRES_URL and GIADA_MASTER_KEY are required');

const sqlite = new Database(resolve(config.databasePath), { readonly: true });
const table = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories'").get();
let imported = 0;
if (table) {
  const rows = sqlite.prepare('SELECT * FROM memories').all() as Array<{
    id: string; content: string; summary: string | null; tags: string; source: MemoryRecord['source'];
    privacy: MemoryRecord['privacy']; created_at: string; updated_at: string; expires_at: string | null;
  }>;
  for (const row of rows) {
    imported += await platform.store.importLegacyMemory(ownerId, {
      id: row.id,
      content: row.content,
      summary: row.summary,
      tags: JSON.parse(row.tags) as string[],
      source: row.source,
      privacy: row.privacy,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      expiresAt: row.expires_at
    }) ? 1 : 0;
  }
}
sqlite.close();
await platform.database.close();
process.stdout.write(`Imported ${imported} legacy memories into owner scope ${ownerId}.\n`);

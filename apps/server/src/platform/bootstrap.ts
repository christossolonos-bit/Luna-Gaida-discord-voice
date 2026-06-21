import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AppConfig } from '../config/env.js';
import { PlatformDatabaseClient } from './database.js';
import { SecretBox } from './secrets.js';
import { PlatformStore } from './store.js';

export async function createPlatform(config: AppConfig) {
  if (!config.GIADA_POSTGRES_URL || !config.GIADA_MASTER_KEY) return null;
  const database = new PlatformDatabaseClient(config.GIADA_POSTGRES_URL);
  const migrationsFolder = [
    resolve(process.cwd(), 'apps/server/drizzle'),
    resolve(process.cwd(), 'drizzle')
  ].find(existsSync);
  if (!migrationsFolder) throw new Error('Could not find apps/server/drizzle migrations');
  await database.migrate(migrationsFolder);
  const secrets = new SecretBox(config.GIADA_MASTER_KEY);
  await secrets.ready();
  const store = new PlatformStore(database, secrets);
  await store.initialize();
  return { database, store };
}

import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import * as schema from './schema.js';

export type PlatformDatabase = NodePgDatabase<typeof schema>;

export class PlatformDatabaseClient {
  readonly pool: Pool;
  readonly db: PlatformDatabase;

  constructor(url: string) {
    this.pool = new Pool({ connectionString: url, max: 20 });
    this.db = drizzle(this.pool, { schema });
  }

  async migrate(migrationsFolder: string) {
    await migrate(this.db, { migrationsFolder });
  }

  async close() {
    await this.pool.end();
  }
}

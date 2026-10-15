import { randomBytes } from 'node:crypto';
import pg from 'pg';

const ENV = 'LOOPWORK_TEST_DATABASE_URL';

export interface TestSchema {
  pool: pg.Pool;
  schema: string;
  dispose(): Promise<void>;
}

/**
 * Creates a throwaway schema `t_<random hex>` and a Pool pinned to it via search_path.
 * Every call yields a fresh, empty schema, so callers wanting isolation per store just call it again.
 * Throws (never skips) when LOOPWORK_TEST_DATABASE_URL is unset.
 */
export async function withTestSchema(): Promise<TestSchema> {
  const url = process.env[ENV];
  if (!url) {
    throw new Error(`${ENV} is not set: the pg tests need a Postgres (docker compose -p loopwork-test -f docker-compose.test.yml up -d --wait)`);
  }
  const schema = `t_${randomBytes(8).toString('hex')}`;
  const admin = new pg.Pool({ connectionString: url, max: 1 });
  try {
    await admin.query(`create schema ${schema}`);
  } finally {
    await admin.end();
  }
  const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
  return {
    pool,
    schema,
    async dispose() {
      await pool.end();
      const cleanup = new pg.Pool({ connectionString: url, max: 1 });
      try {
        await cleanup.query(`drop schema if exists ${schema} cascade`);
      } finally {
        await cleanup.end();
      }
    },
  };
}

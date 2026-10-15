import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

// Resolves to <package>/migrations from both src/ (vitest) and dist/ (built).
const OWN_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));
// ponytail: fixed key, database-wide: migrate calls in different schemas of one database serialize too.
const LOCK_KEY = 7_262_024_001n;

export class SchemaTooNewError extends Error {
  readonly code = 'E_SCHEMA_NEWER';
}
export class MigrationConflictError extends Error {
  readonly code = 'E_MIGRATION_CONFLICT';
}

interface Migration {
  version: number;
  file: string;
}

async function load(dirs: string[]): Promise<Migration[]> {
  const byVersion = new Map<number, string>();
  for (const dir of [OWN_DIR, ...dirs]) {
    for (const name of await readdir(dir)) {
      const m = /^(\d+)_.+\.sql$/.exec(name);
      if (!m) continue;
      const version = Number(m[1]);
      const other = byVersion.get(version);
      if (other !== undefined) throw new MigrationConflictError(`migration version ${version} is declared twice: ${other} and ${join(dir, name)}`);
      byVersion.set(version, join(dir, name));
    }
  }
  return [...byVersion].map(([version, file]) => ({ version, file })).sort((a, b) => a.version - b.version);
}

export async function migrate(pool: Pool, opts: { dirs?: string[] } = {}): Promise<{ applied: number[] }> {
  const known = await load(opts.dirs ?? []);
  const client = await pool.connect();
  try {
    await client.query('select pg_advisory_lock($1)', [LOCK_KEY]);
    try {
      await client.query(
        'create table if not exists schema_migrations (version int primary key, applied_at timestamptz not null default now())',
      );
      const done = new Set((await client.query<{ version: number }>('select version from schema_migrations')).rows.map((r) => r.version));
      const unknown = [...done].filter((v) => !known.some((k) => k.version === v));
      if (unknown.length > 0) throw new SchemaTooNewError(`database has migrations this code does not know: ${unknown.join(', ')}`);
      const applied: number[] = [];
      for (const { version, file } of known) {
        if (done.has(version)) continue;
        await client.query('begin');
        try {
          await client.query(await readFile(file, 'utf8'));
          await client.query('insert into schema_migrations (version) values ($1)', [version]);
          await client.query('commit');
        } catch (e) {
          await client.query('rollback');
          throw e;
        }
        applied.push(version);
      }
      return { applied };
    } finally {
      await client.query('select pg_advisory_unlock($1)', [LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

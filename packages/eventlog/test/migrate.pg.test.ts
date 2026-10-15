import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationConflictError, migrate, SchemaTooNewError } from '../src/migrate.js';
import { withTestSchema } from './pg-helper.js';
import type { TestSchema } from './pg-helper.js';

describe('migrate', () => {
  let t: TestSchema;
  const tmpDirs: string[] = [];
  beforeEach(async () => {
    t = await withTestSchema();
  });
  afterEach(async () => {
    await t.dispose();
    await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function extraDir(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'loopwork-migrations-'));
    tmpDirs.push(dir);
    for (const [name, sql] of Object.entries(files)) await writeFile(join(dir, name), sql);
    return dir;
  }

  const versions = async (): Promise<number[]> =>
    (await t.pool.query<{ version: number }>('select version from schema_migrations order by version')).rows.map((r) => r.version);

  it('creates the runs/events tables and the runs_status_created index from the spec', async () => {
    await migrate(t.pool);
    const tables = await t.pool.query<{ table_name: string }>(
      'select table_name from information_schema.tables where table_schema = $1 order by table_name',
      [t.schema],
    );
    expect(tables.rows.map((r) => r.table_name)).toEqual(['events', 'runs', 'schema_migrations']);
    const idx = await t.pool.query<{ indexdef: string }>(
      'select indexdef from pg_indexes where schemaname = $1 and indexname = $2',
      [t.schema, 'runs_status_created'],
    );
    expect(idx.rows).toHaveLength(1);
    expect(idx.rows[0]?.indexdef).toMatch(/\(status, created_at DESC\)/);
  });

  it('EL-9: migrate is idempotent', async () => {
    expect(await migrate(t.pool)).toEqual({ applied: [1] });
    expect(await migrate(t.pool)).toEqual({ applied: [] });
    expect(await versions()).toEqual([1]);
  });

  it('EL-9: concurrent callers are serialized', async () => {
    const results = await Promise.all([migrate(t.pool), migrate(t.pool), migrate(t.pool), migrate(t.pool)]);
    const applied = results.map((r) => r.applied);
    expect(applied.filter((a) => a.length > 0)).toEqual([[1]]);
    expect(applied.filter((a) => a.length === 0)).toHaveLength(3);
    expect(await versions()).toEqual([1]);
  });

  it('EL-9: refuses a newer-than-known schema', async () => {
    await migrate(t.pool);
    await t.pool.query('insert into schema_migrations (version) values (999)');
    const err = await migrate(t.pool).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SchemaTooNewError);
    expect((err as SchemaTooNewError).code).toBe('E_SCHEMA_NEWER');
  });

  it('EL-9: extra dirs are applied in numeric order across dirs', async () => {
    const dir = await extraDir({
      '003_third.sql': 'create table third (id int primary key, run_id uuid references extra);',
      '002_extra.sql': 'create table extra (run_id uuid primary key references runs);',
    });
    expect(await migrate(t.pool, { dirs: [dir] })).toEqual({ applied: [1, 2, 3] });
    expect(await versions()).toEqual([1, 2, 3]);
  });

  it('EL-9: a duplicate version across dirs throws MigrationConflictError before anything is applied', async () => {
    const dir = await extraDir({ '001_other.sql': 'create table other (id int primary key);' });
    const err = await migrate(t.pool, { dirs: [dir] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MigrationConflictError);
    expect((err as MigrationConflictError).code).toBe('E_MIGRATION_CONFLICT');
    const found = await t.pool.query<{ runs: string | null; other: string | null }>(
      `select to_regclass('runs') as runs, to_regclass('other') as other`,
    );
    expect(found.rows[0]).toEqual({ runs: null, other: null });
  });
});

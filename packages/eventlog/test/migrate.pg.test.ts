import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationConflictError, migrate, SchemaTooNewError } from '../src/migrate.js';
import { withTestSchema } from './pg-helper.js';
import type { TestSchema } from './pg-helper.js';

describe('migrate', () => {
  let t: TestSchema;
  const tmpDirs: string[] = [];
  const extraPools: pg.Pool[] = [];
  beforeEach(async () => {
    t = await withTestSchema();
  });
  afterEach(async () => {
    await Promise.all(extraPools.splice(0).map((p) => p.end()));
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

  const tableExists = async (name: string): Promise<boolean> =>
    (await t.pool.query<{ r: string | null }>('select to_regclass($1) as r', [name])).rows[0]?.r != null;

  it('EL-9: versions are ordered numerically, not lexicographically (9 before 10)', async () => {
    const dir = await extraDir({
      '10_ten.sql': 'create table ten (id int primary key references nine);',
      '9_nine.sql': 'create table nine (id int primary key);',
    });
    expect(await migrate(t.pool, { dirs: [dir] })).toEqual({ applied: [1, 9, 10] });
  });

  it('EL-9: the duplicate-version conflict is by numeric version (0001 vs 001)', async () => {
    const dir = await extraDir({ '0001_x.sql': 'create table x (id int primary key);' });
    await expect(migrate(t.pool, { dirs: [dir] })).rejects.toBeInstanceOf(MigrationConflictError);
    expect(await tableExists('runs')).toBe(false);
    expect(await tableExists('x')).toBe(false);
  });

  it('EL-9: refuses a schema whose applied versions are below the max known but no longer declared', async () => {
    const dir = await extraDir({
      '002_a.sql': 'create table a (id int primary key);',
      '003_b.sql': 'create table b (id int primary key);',
    });
    expect(await migrate(t.pool, { dirs: [dir] })).toEqual({ applied: [1, 2, 3] });
    await expect(migrate(t.pool)).rejects.toBeInstanceOf(SchemaTooNewError);
  });

  it('EL-9: each migration file runs in a transaction together with its schema_migrations row', async () => {
    const dir = await extraDir({
      '002_self.sql': 'create table self (id int primary key); insert into schema_migrations (version) values (2);',
    });
    await expect(migrate(t.pool, { dirs: [dir] })).rejects.toThrow();
    expect(await tableExists('self')).toBe(false);
    expect(await versions()).toEqual([1]);
  });

  it('EL-9: a failing migration propagates its error, leaves nothing behind, and applies once fixed', async () => {
    const dir = await extraDir({ '002_bad.sql': 'create table bad (id int primary key); select 1/0;' });
    await expect(migrate(t.pool, { dirs: [dir] })).rejects.toThrow(/division by zero/);
    expect(await tableExists('bad')).toBe(false);
    expect(await versions()).toEqual([1]);
    await writeFile(join(dir, '002_bad.sql'), 'create table bad (id int primary key);');
    expect(await migrate(t.pool, { dirs: [dir] })).toEqual({ applied: [2] });
    expect(await tableExists('bad')).toBe(true);
  });

  it('EL-9: files that are not .sql are ignored', async () => {
    const dir = await extraDir({ '002_notes.txt': 'this is not sql' });
    expect(await migrate(t.pool, { dirs: [dir] })).toEqual({ applied: [1] });
  });

  it('EL-9: migrate works on a pool with a single connection', { timeout: 15_000 }, async () => {
    const single = new pg.Pool({
      connectionString: process.env.LOOPWORK_TEST_DATABASE_URL,
      options: `-c search_path=${t.schema}`,
      max: 1,
    });
    extraPools.push(single);
    expect(await migrate(single)).toEqual({ applied: [1] });
    expect(await migrate(single)).toEqual({ applied: [] });
  });
});

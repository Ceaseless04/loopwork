// T32: tests of scripts/criteria-map.mjs (every success-criterion ID maps to a named test, CONSTRAINTS.md).
// This file is excluded from the scan, so it cannot satisfy the list it checks.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');

interface CriteriaMod {
  EXPECTED_IDS: string[];
  findUnmappedCriteria: (opts: { ids: string[]; files: Map<string, string> }) => string[];
  readTree: (root: string, dirs: string[]) => Map<string, string>;
  testDirs: (root: string) => string[];
}
const load = async (): Promise<CriteriaMod> =>
  (await import(pathToFileURL(path.join(root, 'scripts/criteria-map.mjs')).href)) as CriteriaMod;

const unmapped = async (ids: string[], files: Record<string, string>): Promise<string[]> =>
  (await load()).findUnmappedCriteria({ ids, files: new Map(Object.entries(files)) });

describe('findUnmappedCriteria', () => {
  it('reports an ID that no file names', async () => {
    expect(await unmapped(['GM-1', 'GM-2'], { 'a.test.ts': "it('GM-1: x', () => {});" })).toEqual(['GM-2']);
  });

  it('counts it( and test( with single, double and backtick quotes', async () => {
    const files = {
      'a.test.ts': "it('GM-1: x', () => {});",
      'b.test.ts': 'test("GM-2: x", () => {});',
      'c.test.ts': 'it(`GM-3: x`, () => {});',
    };
    expect(await unmapped(['GM-1', 'GM-2', 'GM-3'], files)).toEqual([]);
  });

  it('counts store-contract.ts and *.pg.test.ts but not other files', async () => {
    const files = {
      'packages/eventlog/test/store-contract.ts': "it('EL-1: x', () => {});",
      'packages/eventlog/test/x.pg.test.ts': "it('EL-2: x', () => {});",
      'packages/eventlog/test/helpers.ts': "it('EL-3: x', () => {});",
    };
    expect(await unmapped(['EL-1', 'EL-2', 'EL-3'], files)).toEqual(['EL-3']);
  });

  it('excludes the criteria-map test itself', async () => {
    expect(await unmapped(['SC-1'], { 'scripts/test/criteria-map.test.ts': "it('SC-1: x', () => {});" })).toEqual(['SC-1']);
  });

  it('does not count a comment mention or a describe( title', async () => {
    const files = { 'a.test.ts': "// GM-1: covered elsewhere\ndescribe('GM-2: x', () => {});" };
    expect(await unmapped(['GM-1', 'GM-2'], files)).toEqual(['GM-1', 'GM-2']);
  });

  it('does not let EL-1 be satisfied by EL-10 or the reverse', async () => {
    expect(await unmapped(['EL-1', 'EL-10'], { 'a.test.ts': "it('EL-10: x', () => {});" })).toEqual(['EL-1']);
    expect(await unmapped(['EL-1', 'EL-10'], { 'a.test.ts': "it('EL-1: x', () => {});" })).toEqual(['EL-10']);
  });
});

describe('criteria map of the repository', () => {
  it('expects SC-1..7, GM-1..9, WL-1..8 and EL-1..10', async () => {
    const { EXPECTED_IDS } = await load();
    expect(EXPECTED_IDS).toHaveLength(39);
    expect(EXPECTED_IDS).toContain('SC-7');
    expect(EXPECTED_IDS).toContain('EL-10');
    for (const id of ['EC-1', 'EC-2', 'EC-3', 'EC-9', 'EC-14']) expect(EXPECTED_IDS).toContain(id);
  });

  it('has a named test for every criterion ID', async () => {
    const { EXPECTED_IDS, findUnmappedCriteria, readTree, testDirs } = await load();
    const files = readTree(root, testDirs(root));
    expect(findUnmappedCriteria({ ids: EXPECTED_IDS, files }), 'unmapped criterion IDs').toEqual([]);
  });
});

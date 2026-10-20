// Criteria map (CONSTRAINTS.md "every success criterion has an ID that maps to a named test").
//
//   node scripts/criteria-map.mjs
//
// Prints each criterion ID with the test files that name it; exit 1 if any ID has none, 0 otherwise.
// A criterion is mapped only by `it('<ID>:` / `test('<ID>:` (single, double or backtick quotes) in a *.test.ts file or
// store-contract.ts; this script's own test is excluded so it cannot satisfy its own list.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const range = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}-${i + 1}`);
// Engine-core ids are listed literally: the remaining criteria (EC-10..EC-13) land in later slices, each appending its own.
export const EXPECTED_IDS = [
  ...range('SC', 7),
  ...range('GM', 9),
  ...range('WL', 8),
  ...range('EL', 10),
  'EC-1',
  'EC-2',
  'EC-3',
  'EC-9',
  'EC-14',
  'EC-4',
  'EC-7',
  'EC-8',
  'EC-5',
  'EC-6',
  'EC-15',
];

const counts = (file) => /(\.test\.ts|(^|[\\/])store-contract\.ts)$/.test(file) && !/criteria-map\.test\.ts$/.test(file);

const NAMED_ID = /(?<![\w.])(?:it|test)\(\s*['"`]([A-Z]+-\d+):/g;

/** id -> paths of the counting files that name it. */
export function mapCriteria({ ids, files }) {
  const named = [...files]
    .filter(([file]) => counts(file))
    .map(([file, text]) => [file, new Set([...text.matchAll(NAMED_ID)].map((m) => m[1]))]);
  return new Map(ids.map((id) => [id, named.filter(([, found]) => found.has(id)).map(([file]) => file)]));
}

export function findUnmappedCriteria(opts) {
  return [...mapCriteria(opts)].filter(([, named]) => named.length === 0).map(([id]) => id);
}

const SKIP = new Set(['node_modules', 'dist', 'coverage', 'fixtures']);

/** Repo-relative path -> text of every file under the given repo-relative dirs (skipping node_modules, dist, coverage, fixtures). */
export function readTree(root, dirs) {
  const files = new Map();
  const walk = (dir) => {
    for (const e of readdirSync(path.join(root, dir), { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const rel = path.posix.join(dir, e.name);
      if (e.isDirectory()) walk(rel);
      else files.set(rel, readFileSync(path.join(root, rel), 'utf8'));
    }
  };
  for (const dir of dirs) walk(dir);
  return files;
}

/** The test directories the map scans: packages/* / test and scripts/test. */
export function testDirs(root) {
  const pkgs = readdirSync(path.join(root, 'packages'), { withFileTypes: true }).filter((e) => e.isDirectory());
  return [...pkgs.map((e) => `packages/${e.name}/test`), 'scripts/test'];
}

export function main(root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), out = console.log) {
  const files = readTree(
    root,
    testDirs(root).filter((d) => readdirSync(path.join(root, path.dirname(d))).includes(path.basename(d))),
  );
  const map = mapCriteria({ ids: EXPECTED_IDS, files });
  for (const [id, named] of map) out(`${id}: ${named.length ? named.join(', ') : 'UNMAPPED'}`);
  return findUnmappedCriteria({ ids: EXPECTED_IDS, files }).length === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main();

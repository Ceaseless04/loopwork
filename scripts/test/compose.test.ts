import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');

// The compose file is checked as text (no YAML dependency): comments are dropped first, so a pin written only in a
// comment never counts, then each pin looks at the remaining lines. Values are compared exactly.

/** Non-blank lines that are not full-line `# ...` comments (a trailing `#` may sit inside a quoted string, so it stays). */
function activeLines(text: string): string[] {
  return text.split(/\r?\n/).filter((l) => !/^\s*(#|$)/.test(l));
}

const indentOf = (l: string): number => l.length - l.trimStart().length;
const unquote = (s: string): string => s.trim().replace(/^(["'])(.*)\1$/, '$2');

interface KeyBlock {
  inline: string;
  body: string[];
}

/** Every `key:` occurrence with its inline value and the lines nested under it (list items may sit at the key's indent). */
function keyBlocks(lines: string[], key: string): KeyBlock[] {
  const re = new RegExp(`^\\s*${key}:\\s*(.*)$`);
  const out: KeyBlock[] = [];
  lines.forEach((line, i) => {
    const m = re.exec(line);
    if (!m) return;
    const k = indentOf(line);
    const body: string[] = [];
    for (const next of lines.slice(i + 1)) {
      const n = indentOf(next);
      if (n > k || (n === k && next.trimStart().startsWith('- '))) body.push(next);
      else break;
    }
    out.push({ inline: m[1] ?? '', body });
  });
  return out;
}

/** Scalar entries of a block: inline `[a, b]` or scalar, plus `- item` lines. */
function items(b: KeyBlock): string[] {
  const inline = b.inline.trim();
  const fromInline = inline === '' ? [] : inline.replace(/^\[|\]$/g, '').split(',').map(unquote);
  const fromBody = b.body.map((l) => l.trim()).filter((l) => l.startsWith('- ')).map((l) => unquote(l.slice(2)));
  return [...fromInline, ...fromBody];
}

/** Values of `NAME: value` (map form) or `- NAME=value` (list form) lines. */
function envValues(lines: string[], name: string): string[] {
  const re = new RegExp(`^${name}\\s*[:=]\\s*(.*)$`);
  return lines.flatMap((l) => {
    const m = re.exec(unquote(l.trim().replace(/^- /, '')));
    return m ? [unquote(m[1] ?? '')] : [];
  });
}

function serviceNames(lines: string[]): string[] {
  const i = lines.findIndex((l) => /^services:\s*$/.test(l));
  if (i < 0) return [];
  const children: string[] = [];
  for (const l of lines.slice(i + 1)) {
    if (indentOf(l) === 0) break;
    children.push(l);
  }
  const first = Math.min(...children.map(indentOf));
  return children.filter((l) => indentOf(l) === first).flatMap((l) => /^(\S[^:]*):\s*$/.exec(l.trim())?.[1] ?? []);
}

const DATA_DIR = /^\/var\/lib\/postgresql\/data(:.*)?$/;

/** Named pins; each returns true when the (comment-free) compose text satisfies it. */
const pins: Record<string, (lines: string[]) => boolean> = {
  service: (ls) => JSON.stringify(serviceNames(ls)) === JSON.stringify(['postgres']),
  image: (ls) => JSON.stringify(keyBlocks(ls, 'image').flatMap(items)) === JSON.stringify(['postgres:16']),
  ports: (ls) => {
    const blocks = keyBlocks(ls, 'ports');
    return blocks.length === 1 && JSON.stringify(blocks.flatMap(items)) === JSON.stringify(['127.0.0.1:55432:5432']);
  },
  'loopback only': (ls) => !ls.some((l) => /0\.0\.0\.0|::|network_mode/.test(l)),
  'env POSTGRES_DB': (ls) => JSON.stringify(envValues(ls, 'POSTGRES_DB')) === JSON.stringify(['loopwork_test']),
  'env POSTGRES_USER': (ls) => JSON.stringify(envValues(ls, 'POSTGRES_USER')) === JSON.stringify(['loopwork']),
  'env POSTGRES_PASSWORD': (ls) => JSON.stringify(envValues(ls, 'POSTGRES_PASSWORD')) === JSON.stringify(['loopwork']),
  healthcheck: (ls) => {
    const blocks = keyBlocks(ls, 'healthcheck');
    if (blocks.length !== 1) return false;
    const tests = keyBlocks([...(blocks[0]?.body ?? [])], 'test');
    return tests.length === 1 && /(^|[^A-Za-z0-9_])pg_isready([^A-Za-z0-9_]|$)/.test(tests.flatMap(items).join(' '));
  },
  tmpfs: (ls) => {
    const blocks = keyBlocks(ls, 'tmpfs');
    return blocks.length === 1 && blocks.flatMap(items).some((v) => DATA_DIR.test(v));
  },
};

/** Names of the pins that the given compose text fails. */
function failedPins(text: string): string[] {
  const lines = activeLines(text);
  return Object.entries(pins).flatMap(([name, ok]) => (ok(lines) ? [] : [name]));
}

const anyHost = ['0', '0', '0', '0'].join('.');

// The exact intended file (LF). The pins above only diagnose; this is the backstop for everything they cannot see.
const good = `# Throwaway Postgres for the pg test project (\`pnpm test:pg\`). Published on loopback only.
#
# Usage:
#   docker compose -p loopwork-test -f docker-compose.test.yml up -d --wait
#   LOOPWORK_TEST_DATABASE_URL=postgres://loopwork:loopwork@127.0.0.1:55432/loopwork_test pnpm test:pg
#   docker compose -p loopwork-test -f docker-compose.test.yml down -v
#
# Always pass \`-p loopwork-test\`: it beats COMPOSE_PROJECT_NAME and .env, so \`down -v\` cannot hit another stack.
# The data dir is tmpfs: nothing survives \`down\` (or a container restart).
services:
  postgres:
    image: postgres:16
    ports:
      - "127.0.0.1:55432:5432"
    environment:
      POSTGRES_DB: loopwork_test
      POSTGRES_USER: loopwork
      POSTGRES_PASSWORD: loopwork
    tmpfs:
      - /var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U loopwork -d loopwork_test"]
      interval: 2s
      timeout: 3s
      retries: 30
`;

describe('SC-6 compose file', () => {
  it('SC-6: compose file pins Postgres 16 on 127.0.0.1:55432 with db/user/password loopwork_test/loopwork/loopwork', () => {
    const text = readFileSync(path.join(root, 'docker-compose.test.yml'), 'utf8');
    expect(failedPins(text)).toEqual([]);
    expect(text.replace(/\r\n/g, '\n')).toBe(good);
  });

  it('SC-6: the text pins accept the intended file and reject every mutation of it', () => {
    expect(failedPins(good)).toEqual([]);

    const mutations: [from: string, to: string, pin: string][] = [
      ['image: postgres:16', 'image: postgres:17', 'image'],
      ['image: postgres:16', 'image: postgres:latest', 'image'],
      ['image: postgres:16', 'image: postgres', 'image'],
      ['image: postgres:16', 'image: postgres:17 # postgres:16', 'image'],
      ['    image: postgres:16\n', '', 'image'],
      ['    image: postgres:16', '    # image: postgres:16', 'image'],
      ['postgres:\n    image', 'db:\n    image', 'service'],
      ['  postgres:\n', '  postgres:\n    image: postgres:16\n  other:\n', 'service'],
      ['127.0.0.1:55432:5432', `${anyHost}:55432:5432`, 'ports'],
      ['127.0.0.1:55432:5432', `${anyHost}:55432:5432`, 'loopback only'],
      ['127.0.0.1:55432:5432', '55432:5432', 'ports'],
      ['127.0.0.1:55432:5432', '127.0.0.1:5432:5432', 'ports'],
      ['127.0.0.1:55432:5432', '127.0.0.1:55433:5432', 'ports'],
      ['127.0.0.1:55432:5432', '127.0.0.1:55432:5433', 'ports'],
      ['127.0.0.1:55432:5432', '127.0.0.2:55432:5432', 'ports'],
      ['127.0.0.1:55432:5432"\n', '127.0.0.1:55432:5432"\n      - "5432:5432"\n', 'ports'],
      ['127.0.0.1:55432:5432"\n', `127.0.0.1:55432:5432"\n      - "${anyHost}:55433:5432"\n`, 'loopback only'],
      ['      - "127.0.0.1:55432:5432"\n', '', 'ports'],
      ['      - "127.0.0.1:55432:5432"', '      # - "127.0.0.1:55432:5432"', 'ports'],
      ['    ports:\n', '    ports:\n      - "127.0.0.1:55433:5432"\n', 'ports'],
      ['    tmpfs:', '    network_mode: host\n    tmpfs:', 'loopback only'],
      ['POSTGRES_DB: loopwork_test', 'POSTGRES_DB: loopwork', 'env POSTGRES_DB'],
      ['POSTGRES_DB: loopwork_test', 'POSTGRES_DB: loopwork_test2', 'env POSTGRES_DB'],
      ['      POSTGRES_DB: loopwork_test\n', '', 'env POSTGRES_DB'],
      ['      POSTGRES_DB: loopwork_test', '      # POSTGRES_DB: loopwork_test', 'env POSTGRES_DB'],
      ['POSTGRES_USER: loopwork', 'POSTGRES_USER: postgres', 'env POSTGRES_USER'],
      ['POSTGRES_USER: loopwork', 'POSTGRES_USER: loopwork_test', 'env POSTGRES_USER'],
      ['      POSTGRES_USER: loopwork\n', '', 'env POSTGRES_USER'],
      ['      POSTGRES_USER: loopwork', '      # POSTGRES_USER: loopwork', 'env POSTGRES_USER'],
      ['POSTGRES_PASSWORD: loopwork', 'POSTGRES_PASSWORD: postgres', 'env POSTGRES_PASSWORD'],
      ['POSTGRES_PASSWORD: loopwork', 'POSTGRES_PASSWORD: loopwork2', 'env POSTGRES_PASSWORD'],
      ['      POSTGRES_PASSWORD: loopwork\n', '', 'env POSTGRES_PASSWORD'],
      ['      POSTGRES_PASSWORD: loopwork', '      # POSTGRES_PASSWORD: loopwork', 'env POSTGRES_PASSWORD'],
      ['pg_isready -U', 'true -U', 'healthcheck'],
      ['pg_isready', 'pg_isreadyx', 'healthcheck'],
      ['      test: [', '      # test: [', 'healthcheck'],
      ['    healthcheck:', '    # healthcheck:', 'healthcheck'],
      ['    healthcheck:\n      test: ["CMD-SHELL", "pg_isready -U loopwork -d loopwork_test"]\n', '', 'healthcheck'],
      ['    tmpfs:\n      - /var/lib/postgresql/data\n', '', 'tmpfs'],
      ['    tmpfs:', '    # tmpfs:', 'tmpfs'],
      ['/var/lib/postgresql/data', '/var/lib/postgresql', 'tmpfs'],
      ['/var/lib/postgresql/data', '/tmp/data', 'tmpfs'],
    ];

    for (const [from, to, pin] of mutations) {
      expect(good, `mutation source ${JSON.stringify(from)}`).toContain(from);
      expect(failedPins(good.replace(from, to)), `${JSON.stringify(from)} -> ${JSON.stringify(to)}`).toContain(pin);
    }

    // Text that only mentions the pins in comments satisfies none of the positive pins (`loopback only` is a ban, so
    // empty text trivially honours it).
    const commentedOut = good
      .split('\n')
      .map((l) => `# ${l}`)
      .join('\n');
    expect(failedPins(commentedOut)).toEqual(Object.keys(pins).filter((n) => n !== 'loopback only'));
  });

  it('SC-6: test:pg script runs the pg project', () => {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.['test:pg']).toBe('vitest run --project pg --passWithNoTests');
  });
});

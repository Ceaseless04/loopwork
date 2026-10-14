import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { joinCmd, joinPosix, quoteCmd, quotePosix } from '../src/quote.js';

const corpus = [
  "it's",
  "it's a 'quoted' word",
  'say "hi"',
  'a b  c',
  '$HOME',
  '$(echo pwned)',
  '`echo pwned`',
  'a;b',
  'a&b',
  'a|b',
  '100%',
  'a\\b',
  'C:\\dir\\',
  'line1\nline2\n',
  '-n',
  '--flag=value',
  '',
  'h\u00e9llo \u2713 \u{1f600}',
];

// Consumer-style: an outer shell runs the inner `sh -c 'printf %s "$1"' _ <quoted>`.
const runSh = (script: string): Buffer => {
  const r = spawnSync('sh', ['-c', script]);
  expect(r.status).toBe(0);
  return r.stdout;
};

describe('quote', () => {
  it('WL-3: quotePosix round-trips hostile strings through real sh', () => {
    for (const input of corpus) {
      const out = runSh(`sh -c 'printf %s "$1"' _ ${quotePosix(input)}`);
      expect(out.equals(Buffer.from(input, 'utf8')), JSON.stringify(input)).toBe(true);
    }
  });

  it('WL-3: joinPosix preserves argument boundaries through real sh', () => {
    const out = runSh(`printf '%s\\0' ${joinPosix(corpus)}`);
    const args = out.toString('utf8').split('\0').slice(0, -1);
    expect(args).toEqual(corpus);
  });

  it('WL-3: quoteCmd matches the expectation table', () => {
    // Stage 1 = CommandLineToArgvW quoting; stage 2 = caret-escape every cmd metachar ( ) % ! ^ " < > & | in the stage-1 result.
    const table: [string, string, string][] = [
      ['plain', 'plain', 'no space/tab/quote: stage 1 leaves it bare, no metachars'],
      ['', '^"^"', 'empty arg must stay an argument: stage 1 gives "", stage 2 carets the quotes'],
      ["it's", "it's", 'single quote is not special to cmd or argv parsing'],
      ['say "hi"', '^"say \\^"hi\\^"^"', 'stage 1 "say \\"hi\\"", then every quote is careted'],
      ['$HOME', '$HOME', '$ is not a cmd metachar'],
      ['$(id)', '$^(id^)', 'parens are careted; no space so no quoting'],
      ['$(echo pwned)', '^"$^(echo pwned^)^"', 'space forces stage-1 quotes, then parens and quotes are careted'],
      ['`echo pwned`', '^"`echo pwned`^"', 'backtick is not a cmd metachar; space forces quotes'],
      ['a;b', 'a;b', '; is not a cmd metachar here'],
      ['a&b', 'a^&b', '& is careted'],
      ['&calc', '^&calc', 'leading & is careted so it cannot start a command'],
      ['a<b>|c', 'a^<b^>^|c', '< > | are careted'],
      ['a^b', 'a^^b', '^ is careted'],
      ['100%', '100^%', '% is careted'],
      ['hi!', 'hi^!', '! is careted (delayed expansion)'],
      ['C:\\dir\\', 'C:\\dir\\', 'no space/tab/quote: trailing backslash untouched'],
      ['C:\\my dir\\', '^"C:\\my dir\\\\^"', 'quoted, so the backslash before the closing quote is doubled'],
      ['C:\\my dir\\\\', '^"C:\\my dir\\\\\\\\^"', 'two trailing backslashes in quotes: both doubled before the closing quote'],
      ['a\tb', '^"a\tb^"', 'tab forces quoting'],
      ['a\\"b', '^"a\\\\\\^"b^"', 'stage 1 "a\\\\\\"b" (backslash doubled, quote escaped); only the quotes are careted'],
      ['"&calc', '^"\\^"^&calc^"', 'quote escaped then careted, & careted regardless of quote state'],
      ['line1\nline2', '^"line1 line2^"', 'LF becomes a space first (documented limitation), so stage 1 quotes it'],
      ['a\rb', '^"a b^"', 'CR becomes a space first, so stage 1 quotes it'],
      ['h\u00e9llo\u2713', 'h\u00e9llo\u2713', 'unicode is untouched'],
    ];
    for (const [input, expected, why] of table) expect(quoteCmd(input), `${JSON.stringify(input)}: ${why}`).toBe(expected);
  });

  it('WL-3: joinCmd joins quoted args with a single space', () => {
    expect(joinCmd(['echo', 'a b', '&calc'])).toBe('echo ^"a b^" ^&calc');
  });
});

// Single quotes are literal in POSIX sh: always wrap, and close/escape/reopen for each embedded `'`.
export const quotePosix = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`;

export const joinPosix = (args: readonly string[]): string => args.map(quotePosix).join(' ');

export const quoteCmd = (s: string): string => {
  // Documented limits. A raw newline cannot ride in one cmd command line: flatten to a space. `^%` relies on no
  // variable whose name ends in `^`. `^!` does not stop `!VAR!` expansion under /V:ON: value substitution only, no command injection.
  const flat = s.replace(/[\r\n]/g, ' ');
  // Empty must stay an argument (`""`); no space/tab/quote needs no argv quoting.
  const argv =
    flat !== '' && !/[ \t"]/.test(flat)
      ? flat
      : // Backslashes before a `"` are doubled and the `"` escaped; backslashes before the closing quote are doubled.
        `"${flat.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`;
  // Caret-escape every cmd metacharacter, even inside quotes, since cmd's quote state is unreliable.
  return argv.replace(/[()%!^"<>&|]/g, '^$&');
};

export const joinCmd = (args: readonly string[]): string => args.map(quoteCmd).join(' ');

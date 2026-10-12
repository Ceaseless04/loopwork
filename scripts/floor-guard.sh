#!/usr/bin/env bash
# Floor guard: enforces the seven "Floor" rules of CONSTRAINTS.md over a unified diff (added lines only).
#
#   floor-guard.sh [--diff-file <path>|-] [--commit-msg-file <path>]
#
# Default diff: tracked changes (staged + unstaged) vs the base, plus untracked files rendered as additions.
# Base: $LOOPWORK_BASE_REF, else `git merge-base HEAD main`.
# Exit 0 = clean. Otherwise one `floor-guard: <rule-id> <file>:<line>` line per violation on stderr, exit 1.
# A non-empty `Test-Change-Reason:` line in the commit-message file excuses the skipped-test rule ONLY.
#
# Plain bash + git + awk (portable awk: no gawk extensions, no regex intervals). Rules, by file scope:
#   code files (*.ts *.tsx *.js *.mjs *.cjs): suppression, stub, bind; stdout only under packages/*/src
#   test files (*.test|spec.<code ext>):      skipped-test (skips, deleted file, net-removed `expect(` lines)
#   every file:                               secret
#   CONSTRAINTS.md:                           constraints-weakened (any removed/changed line, any new Exceptions row)
# ponytail: line-based regexes, not a parser (multi-line constructs and obfuscation are not caught); gitleaks and
# review are the backstop. Upgrade to a real parser only if false negatives show up in practice.
#
# Fails CLOSED: if git cannot build the diff (bad base ref, not a repo, git missing) the exit is 2 with a
# `floor-guard: error: ...` line, never 0. Exit 2 also covers usage errors. The guard's own diffs use --no-renames
# (a rename is a delete + an add, so it cannot hide a CONSTRAINTS.md removal or a dropped *.test.ts) and
# core.quotePath=false (non-ASCII names such as café.ts reach awk unquoted).
#
# Known limits (not detected; gitleaks in T08/T09 and review are the backstop):
#   - paths git must still C-quote (names containing tab, newline, double quote or backslash) are skipped;
#   - multi-line empty catch blocks, process['stdout'], a split `console` newline `.log`, it.skipIf / it.only,
#     symlinked files, nested repos, and unquoted PASSWORD=value / api_key: value secrets;
#   - when the base lacks CONSTRAINTS.md, the Exceptions table header and separator count as added rows. The real
#     flow always sets LOOPWORK_BASE_REF to a base that has it.
set -euo pipefail

usage() { echo "usage: floor-guard.sh [--diff-file <path>|-] [--commit-msg-file <path>]" >&2; exit 2; }
die() { echo "floor-guard: error: $1" >&2; exit 2; }

diff_file="" msg_file=""
while [ $# -gt 0 ]; do
  case "$1" in
    --diff-file) [ $# -ge 2 ] || usage; diff_file="$2"; shift 2 ;;
    --commit-msg-file) [ $# -ge 2 ] || usage; msg_file="$2"; shift 2 ;;
    *) usage ;;
  esac
done

excuse=0
if [ -n "$msg_file" ]; then
  [ -r "$msg_file" ] || die "cannot read $msg_file"
  if grep -Eq '^Test-Change-Reason:[[:space:]]*[^[:space:]]' "$msg_file"; then excuse=1; fi
fi

# Resolve everything that can fail in the main shell (a failure inside the pipeline below must not read as "clean").
if [ -z "$diff_file" ]; then
  top="$(git rev-parse --show-toplevel)" || die "not a git repository (or git is missing)"
  cd "$top"
  base="${LOOPWORK_BASE_REF:-}"
  if [ -z "$base" ]; then
    base="$(git merge-base HEAD main)" || die "no base: set LOOPWORK_BASE_REF or create a main branch"
  fi
elif [ "$diff_file" != "-" ] && [ ! -r "$diff_file" ]; then
  die "cannot read $diff_file"
fi

# Every failure must propagate (callers run this under `||`, where set -e is off): a masked git error would read as "clean".
gdiff() { git -c core.quotePath=false diff --no-color --no-ext-diff --no-renames --src-prefix=a/ --dst-prefix=b/ "$@"; }
emit_diff() {
  if [ -n "$diff_file" ]; then cat -- "$diff_file"; return; fi
  gdiff "$base" -- || return 1
  git ls-files --others --exclude-standard -z | while IFS= read -r -d '' f; do
    gdiff --no-index -- /dev/null "$f" || [ $? -eq 1 ] || exit 1 # exit 1 = "differs"
  done || return 1
}

read -r -d '' PROG <<'AWK' || true
function viol(rule, f, ln,   k) {
  if (rule == "skipped-test" && excuse) return
  k = rule SUBSEP f SUBSEP ln
  if (k in seen) return
  seen[k] = 1; bad = 1
  print "floor-guard: " rule " " f ":" ln
}
function pipes(s,   t) { t = s; return gsub(/[|]/, "", t) }
function rep(s, n,   r) { r = ""; while (n-- > 0) r = r s; return r }
function endfile() {
  if (file != "" && !deleted && istest && remexp > addexp) viol("skipped-test", file, expln)
  file = ""; deleted = 0; remexp = addexp = 0; expln = 1; rold = rnew = 0
}
function setfile(f) {
  file = f
  code = f ~ /[.](ts|tsx|js|mjs|cjs)$/
  istest = f ~ /[.](test|spec)[.](ts|tsx|js|mjs|cjs)$/
  isstdout = code && f ~ /^packages\/[^\/]+\/src\//
}
function checkdeleted() { if (deleted && istest) viol("skipped-test", file, 1) }

function added(t, ln,   lt, s, i) {
  lt = tolower(t)
  if (code) {
    # Suppressions and TODOs only count inside comments (// ... or /* ... or a ` * ` continuation), so a string or
    # test title that merely names them does not trip the guard.
    if (t ~ /(\/\/|\/[*]|^[ \t]*[*]).*(@ts-ignore|eslint-disable|istanbul ignore|nosemgrep|gitleaks:allow|v8 ignore)/ ||
        t ~ /(\/\/|\/[*]|^[ \t]*[*]).*@ts-expect-error[ \t:]*([*][\/])?[ \t]*$/) viol("suppression", file, ln)
    if (lt ~ /throw new error[(]["'`]not implemented/ || t ~ /catch[ \t]*([(][^)]*[)])?[ \t]*[{][ \t]*[}]/ ||
        t ~ /(\/\/|\/[*]|^[ \t]*[*]).*(^|[^A-Za-z0-9_])TODO([^A-Za-z0-9_]|$)/) viol("stub", file, ln)
    if (t ~ /0[.]0[.]0[.]0/ || t ~ /["'`]::["'`]/) viol("bind", file, ln)
    # `host:` options must be loopback; a bare type annotation (`host: string`) is not an option.
    if (match(t, /(^|[ \t{,(])["']?host["']?[?]?[ \t]*:/)) {
      s = substr(t, RSTART + RLENGTH); sub(/^[ \t]+/, "", s)
      if (s !~ /^["'`](127[.]0[.]0[.]1|localhost|::1)["'`]/ && s !~ /^string[ \t]*[;,}]?[ \t]*$/) viol("bind", file, ln)
    }
  }
  if (isstdout && (t ~ /console[.](log|info|debug)/ || t ~ /(^|[^A-Za-z0-9_])process[.]stdout/ || t ~ /globalThis[.]console/ ||
      t ~ /=[ \t]*console[ \t]*([;,)]|$)/)) viol("stdout", file, ln)
  if (istest) {
    if (t ~ /[.](skip|todo)[ \t]*[(.]/ || t ~ /(^|[^A-Za-z0-9_])x(it|describe|test)[(]/) viol("skipped-test", file, ln)
    if (t ~ /(^|[^A-Za-z0-9_])expect[(]/) addexp++
  }
  if (file == "CONSTRAINTS.md" && inexc && t ~ /^[|]/) viol("constraints-weakened", file, ln)
  if (file !~ /^scripts\/test\/fixtures\/floor-guard\//) secret(t, lt, ln)
}

# Whole-diff exemption for secret: scripts/test/fixtures/floor-guard/ holds the guard's own fixture diffs, which
# carry documented placeholder secrets on purpose (AWS's published example key etc.); the path is exempt from the
# secret rule only. ALLOW is the documented Postgres test database URL (throwaway loopback container, by design).
function secret(t, lt, ln,   i) {
  while ((i = index(t, allow)) > 0) t = substr(t, 1, i - 1) substr(t, i + length(allow))
  lt = tolower(t)
  if (t ~ /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\/:@ \t]+:[^\/@ \t$<{][^\/@ \t]*@/ ||
      t ~ /-----BEGIN [A-Z ]*PRIVATE KEY-----/ ||
      t ~ ("(AKIA|ASIA)" rep("[0-9A-Z]", 16)) || t ~ ("gh[pousr]_" rep("[A-Za-z0-9]", 36)) || t ~ ("AIza" rep("[0-9A-Za-z_-]", 35)) ||
      lt ~ /(password|passwd|secret|api[_-]?key)[a-z0-9_]*["']?[ \t]*[:=][ \t]*["'][^"' \t$][^"' \t][^"' \t][^"' \t]/) viol("secret", file, ln)
}

function context(t) {
  if (t ~ /^## Exceptions/ || t ~ /^[|] ID [|] Rule [|]/ || t ~ /^[|]---[|]---[|]---[|]---[|]---[|]---[|]$/ || (t ~ /^[|]/ && pipes(t) >= 7)) inexc = 1
  else if (t ~ /^## /) inexc = 0
}

BEGIN { expln = 1 }
rold > 0 || rnew > 0 {
  c = substr($0, 1, 1); t = substr($0, 2)
  if (c == "+") { added(t, nline); context(t); nline++; rnew-- }
  else if (c == "-") {
    rold--
    if (file == "CONSTRAINTS.md") viol("constraints-weakened", file, oline)
    if (istest && t ~ /(^|[^A-Za-z0-9_])expect[(]/) { if (!remexp) expln = nline; remexp++ }
    oline++
  } else if (c == " " || $0 == "") { context(t); nline++; oline++; rold--; rnew-- }
  next
}
/^diff --git / { endfile(); f = $0; sub(/^diff --git a\/.* b\//, "", f); setfile(f); next }
/^deleted file mode/ { deleted = 1; checkdeleted(); next }
/^--- / { prev = substr($0, 5); sub(/\t$/, "", prev); sub(/^a\//, "", prev); next }
/^[+][+][+] / {
  p = substr($0, 5); sub(/\t$/, "", p) # git appends a TAB after names containing spaces
  if (p == "/dev/null") { if (file != prev) { endfile(); setfile(prev) } if (!deleted) { deleted = 1; checkdeleted() } }
  else { sub(/^b\//, "", p); if (file != p) { endfile(); setfile(p) } }
  next
}
/^@@ / {
  if (match($0, /^@@ -[0-9]+(,[0-9]+)? [+][0-9]+(,[0-9]+)? @@/)) {
    h = substr($0, 4, RLENGTH - 6); split(h, hp, " ")
    o = hp[1]; n = hp[2]; sub(/^-/, "", o); sub(/^[+]/, "", n)
    split(o, oa, ","); split(n, na, ",")
    oline = oa[1] + 0; rold = (oa[2] == "" ? 1 : oa[2] + 0)
    nline = na[1] + 0; rnew = (na[2] == "" ? 1 : na[2] + 0)
    inexc = 0
  }
  next
}
END { endfile(); exit bad ? 1 : 0 }
AWK

diff="$(emit_diff)" || die "cannot build the diff (git failed; bad base ref?)"
status=0
printf '%s\n' "$diff" | awk -v excuse="$excuse" -v allow='postgres://loopwork:loopwork@127.0.0.1:55432/loopwork_test' "$PROG" >&2 || status=$?
exit "$status"

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
#   code files (*.ts *.tsx *.mts *.cts *.js *.mjs *.cjs *.jsx): suppression, stub, bind; stdout only under packages/*/src
#   test files (*.test|spec.<code ext>):      skipped-test (skips, deleted file, net-removed `expect(` / `expect.x(` lines)
#   every file:                               secret (scripts/test/fixtures/floor-guard/<name>.diff exempt: documented fakes)
#   CONSTRAINTS.md:                           constraints-weakened (any removed/changed line, any added line under Exceptions,
#                                             any zero-context hunk)
# ponytail: line-based regexes, not a parser (multi-line constructs and obfuscation are not caught); gitleaks and
# review are the backstop. Upgrade to a real parser only if false negatives show up in practice.
#
# Fails CLOSED: if git cannot build the diff (bad base ref, not a repo, git missing) or a path is C-quoted by git
# (names with tab, newline, double quote or backslash), the exit is 2 with a `floor-guard: error: ...` line, never 0.
# Exit 2 also covers usage errors. The guard's own diffs use --no-renames (a rename is a delete + an add, so it cannot
# hide a CONSTRAINTS.md removal or a dropped *.test.ts), --text --no-textconv (diff attributes cannot hide a diff), -U3
# (diff.context cannot strip the Exceptions context; GIT_DIFF_OPTS is unset because it would override -U3) and
# core.quotePath=false (café.ts reaches awk unquoted). Untracked files are added intent-to-add to a throwaway copy of the
# index with --literal-pathspecs (a file named like pathspec magic cannot exclude another); the real index is never written.
#
# Known limits (not detected, or accepted false positives; gitleaks in T08/T09, lint and review are the backstop):
#   - semantic assertion weakening: only the net count of `expect(` / `expect.x(` lines is checked, so if (false) guards,
#     expect(true).toBe(true), toBeDefined, helper edits and assert.* are not detected;
#   - additions outside Exceptions that loosen the rules (for example a new Floor bullet) are allowed: review decides;
#   - multi-line `listen({` objects without a literal `host:` line are not detected, and hosts must be string literals
#     (host: process.env.HOST fails by design);
#   - default mode diffs the working tree, not the index: a staged change reverted on disk is not seen;
#   - secrets beyond the documented forms (URL credentials, private keys, AKIA/ASIA, ghp_, AIza, quoted
#     password/passwd/secret/api_key values); unquoted PASSWORD=value is not seen;
#   - stdout variants (process['stdout'], a split `console` newline `.log`) and packages/* code outside src/: the lint
#     no-console rule is the backstop;
#   - a @ts-expect-error with a one-character reason: the lint minimum description length is the backstop;
#   - false positives, with workarounds: `host: stringify(x)` reads as a non-loopback host, a TODO or FIXME in
#     a comment is a stub even when documenting history, `catch {}` in a template string is an empty catch (reword it);
#   - LOOPWORK_BASE_REF=HEAD is allowed by design (it checks only uncommitted work);
#   - weakening of config files (eslint, vitest, dependency-cruiser thresholds) is review's job, not the guard's;
#   - symlinked files and nested repos (git reports them as a single entry); a nested repo without a commit makes the
#     guard exit 2, one with a commit prints git's embedded-repo warning on stderr;
#   - lowercase `todo` comments and multi-line empty catch blocks;
#   - `listen(` followed by a newline (any multi-line argument list) is not checked, only `host:` lines inside it are;
#   - an `expect(` inside a string that follows other text on the line still counts as a real call;
#   - new TypeError('Not implemented') and a NotImplementedError class are not detected as stubs (only Error is);
#   - core.splitIndex leaves a sharedindex.* file in .git (the throwaway index is a copy, the shared part is not);
#   - GIT_DIR exported without GIT_WORK_TREE, run from a subdirectory: git takes the cwd as the worktree and every
#     file reads as added or deleted (a flood of false positives; unset GIT_DIR or export both);
#   - a clean filter (filter=<name> attribute plus a local filter.<name>.clean command) rewrites worktree content before the diff and can hide even committed lines; a fresh checkout without that config is the backstop;
#   - uncommitted edits to files marked --assume-unchanged / --skip-worktree (or reported unchanged by a core.fsmonitor hook) are not seen; committed content still is;
#   - gitignored files (.gitignore, core.excludesFile, info/exclude) are not scanned; with sparse-checkout, an untracked file outside the sparse set makes the guard exit 2;
#   - when the base lacks CONSTRAINTS.md the whole new file is one zero-context hunk and fails constraints-weakened; the
#     real flow always sets LOOPWORK_BASE_REF to a base that has it.
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

tmp="$(mktemp -d)" || die "mktemp failed"
trap 'rm -rf -- "$tmp"' EXIT
# Resolve everything that can fail in the main shell (a failure inside the pipeline below must not read as "clean").
if [ -z "$diff_file" ]; then
  out="$(git rev-parse --show-toplevel --git-path index)" || die "not a git repository (or git is missing)"
  # --git-path is relative to the current directory: copy the index before cd.
  cp -- "${out#*$'\n'}" "$tmp/index" || die "cannot copy the git index"
  cd "${out%%$'\n'*}" || die "cannot cd to the repository top level"
  base="${LOOPWORK_BASE_REF:-}"
  if [ -z "$base" ]; then
    base="$(git merge-base HEAD main)" || die "no base: set LOOPWORK_BASE_REF or create a main branch"
  fi
  base="$(git rev-parse --verify --quiet --end-of-options "$base^{commit}")" || die "bad base ref: ${LOOPWORK_BASE_REF:-merge-base}"
elif [ "$diff_file" != "-" ] && [ ! -r "$diff_file" ]; then
  die "cannot read $diff_file"
fi

# GIT_DIFF_OPTS=--unified=N overrides -U3 (the environment wins over the command line), so it must not reach git.
unset GIT_DIFF_OPTS
# Every failure must propagate (callers run this under `||`, where set -e is off): a masked git error would read as "clean".
gdiff() { git -c core.quotePath=false diff --no-color --no-ext-diff --no-textconv --text -U3 --no-renames --src-prefix=a/ --dst-prefix=b/ "$@"; }
emit_diff() {
  if [ -n "$diff_file" ]; then cat -- "$diff_file"; return; fi
  # Untracked files join the diff as intent-to-add entries of a throwaway copy of the index (one git diff instead of
  # one spawn per file; the real index is never written).
  git ls-files --others --exclude-standard -z > "$tmp/untracked" || return 1
  if [ -s "$tmp/untracked" ]; then
    GIT_INDEX_FILE="$tmp/index" git --literal-pathspecs -c advice.addEmbeddedRepo=false add -N --pathspec-from-file="$tmp/untracked" --pathspec-file-nul || return 1
  fi
  GIT_INDEX_FILE="$tmp/index" gdiff "$base" --
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
  code = f ~ /[.]([mc]?ts|tsx|[mc]?js|jsx)$/
  istest = f ~ /[.](test|spec)[.]([mc]?ts|tsx|[mc]?js|jsx)$/
  isstdout = code && f ~ /^packages\/[^\/]+\/src\//
}
# A real expect call: not in a comment-only line, a trailing comment or right after a quote (a string naming it).
function hasexp(t,   s) {
  if (t ~ /^[ \t]*([*]|\/[*]|\/\/)/) return 0
  s = t; sub(/(^|[ \t;{})])\/\/.*$/, "", s); sub(/\/[*].*$/, "", s)
  return s ~ /(^|[^A-Za-z0-9_'"`])expect([.][A-Za-z]+)?[(]/
}
function checkdeleted() { if (deleted && istest) viol("skipped-test", file, 1) }

function added(t, ln,   lt, s, i) {
  lt = tolower(t)
  if (code) {
    # Suppressions and TODOs only count inside comments (// ... or /* ... or a ` * ` continuation), so a string or
    # test title that merely names them does not trip the guard.
    if (t ~ /(\/\/|\/[*]|^[ \t]*[*]).*(@ts-ignore|@ts-nocheck|eslint-disable|istanbul ignore|nosemgrep|gitleaks:allow|v8 ignore)/ ||
        t ~ /(\/\/|\/[*]|^[ \t]*[*]).*@ts-expect-error[ \t:]*([*][\/])?[ \t]*$/) viol("suppression", file, ln)
    if (lt ~ /throw[ \t]+(new[ \t]+)?error[ \t]*[(][ \t]*["'`][^"'`]*not (yet )?implemented/ ||
        t ~ /catch[ \t]*([(][^)]*[)])?[ \t]*[{][ \t]*(\/[*][^*]*[*]\/)?[ \t;]*[}]/ ||
        t ~ /(\/\/|\/[*]|^[ \t]*[*]).*(^|[^A-Za-z0-9_])(TODO|FIXME)([^A-Za-z0-9_]|$)/) viol("stub", file, ln)
    if (t ~ /0[.]0[.]0[.]0/ || t ~ /["'`]::["'`]/) viol("bind", file, ln)
    # listen() binds every interface unless a loopback host is given; a call that opens a multi-line object is left to
    # the host: rule on its later lines. Unix sockets use listen({ path: ... }).
    if (match(t, /[.]listen[(]/)) {
      s = substr(t, RSTART + RLENGTH)
      if (s !~ /^[ \t]*[{]?[ \t]*$/ && s !~ /["'`](127[.]0[.]0[.]1|localhost|::1)["'`]/ && s !~ /path[ \t]*:/) viol("bind", file, ln)
    }
    # `host:` options must be loopback; a bare type annotation (`host: string`) is not an option.
    if (match(t, /(^|[ \t{,(])["']?host(name)?["']?[?]?[ \t]*:/)) {
      s = substr(t, RSTART + RLENGTH); sub(/^[ \t]+/, "", s)
      if (s !~ /^["'`](127[.]0[.]0[.]1|localhost|::1)["'`]/ && s !~ /^string([^A-Za-z0-9_$]|$)/) viol("bind", file, ln)
    }
  }
  if (isstdout && (t ~ /console[.](log|info|debug)/ || t ~ /(^|[^A-Za-z0-9_])process[.]stdout/ || t ~ /globalThis[.]console/ ||
      t ~ /=[ \t]*console[ \t]*([;,)]|$)/)) viol("stdout", file, ln)
  if (istest) {
    if (t ~ /[.](skip|todo)[ \t]*[(.]/ || t ~ /(^|[^A-Za-z0-9_])x(it|describe|test)[(]/) viol("skipped-test", file, ln)
    if (hasexp(t)) addexp++
  }
  if (file == "CONSTRAINTS.md" && inexc && t ~ /[^ \t\r]/) viol("constraints-weakened", file, ln)
  if (file !~ /^scripts\/test\/fixtures\/floor-guard\/[^\/]+[.]diff$/) secret(t, lt, ln)
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
{ sub(/\r$/, "") }
rold > 0 || rnew > 0 {
  c = substr($0, 1, 1); t = substr($0, 2)
  if (c == "+") { added(t, nline); context(t); nline++; rnew-- }
  else if (c == "-") {
    rold--
    if (file == "CONSTRAINTS.md") viol("constraints-weakened", file, oline)
    if (istest && hasexp(t)) { if (!remexp) expln = nline; remexp++ }
    oline++
  } else if (c == " " || $0 == "") { context(t); nline++; oline++; rold--; rnew-- }
  next
}
/^diff --git / {
  if ($0 ~ /"/) { print "floor-guard: error: cannot scan a C-quoted path: " substr($0, 12); err = 1 } # fail closed
  endfile(); f = $0; sub(/^diff --git a\/.* b\//, "", f); setfile(f); next
}
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
    if (file == "CONSTRAINTS.md" && rold == 0) viol("constraints-weakened", file, nline) # zero-context insertion: cannot be placed
  }
  next
}
END { endfile(); exit err ? 2 : bad ? 1 : 0 }
AWK

emit_diff > "$tmp/diff" || die "cannot build the diff (git failed; bad base ref?)"
status=0
awk -v excuse="$excuse" -v allow='postgres://loopwork:loopwork@127.0.0.1:55432/loopwork_test' "$PROG" "$tmp/diff" >&2 || status=$?
exit "$status"

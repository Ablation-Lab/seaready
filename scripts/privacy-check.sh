#!/usr/bin/env bash
# Privacy check for Ablation Lab repos. Runs before every commit through the pre-commit hook
# (enable once per clone with: git config core.hooksPath .githooks). It can also be run by hand.
#
#   privacy-check.sh             scan the staged content (exactly what the next commit will contain)
#   privacy-check.sh --worktree  scan the working tree instead: tracked, modified and untracked files
#
# It looks for:
#   - generic patterns listed below (personal email, secrets, local paths, hardware terms), and
#   - private patterns from .privacy/patterns.txt in the repo root. That file must be git-ignored
#     (keep a .privacy/.gitignore containing "*") and never committed; the check refuses to run otherwise.
#     PRIVACY_PATTERNS=<path> overrides the location.
#
# Known-safe lines can be listed in .privacy-allow (committed). Each entry is the SHA-256 of
# "<path>:<exact line text>", so the allow-list never repeats the text and only that exact line in
# that file is allowed; any edit to the line makes it a match again. Print the hash for a line with:
#   privacy-check.sh --hash <path> <line number>
#
# It fails loudly. Exit codes:
#   0  passed: every pattern ran and nothing matched
#   1  matches found: the commit is blocked
#   2  the check itself is broken (a pattern failed to run, the private list is missing, empty,
#      not ignored or tracked, no files to check, or the self-test failed): the commit is blocked
set -u

# Carriage return and newline, for stripping Windows line endings and joining output lines.
printf -v cr '\r'
printf -v nl '\n'

fail() { echo "privacy-check: BROKEN: $*" >&2; exit 2; }

line_hash() {  # $1 = path, $2 = line text (a trailing CR is ignored)
  local h
  h=$(printf '%s:%s' "$1" "${2%"$cr"}" | sha256sum) || fail "sha256sum failed"
  printf '%s' "${h%% *}"
}

root=$(git rev-parse --show-toplevel 2>/dev/null) || fail "not inside a git repository"
cd "$root" || fail "cannot cd to $root"

mode=staged
case "${1:-}" in
  '') ;;
  --worktree) mode=worktree ;;
  --hash)
    [ $# -eq 3 ] || fail "usage: --hash <path> <line number>"
    [[ "$3" =~ ^[1-9][0-9]*$ ]] || fail "line number must be a positive whole number, not '$3'"
    text=$(git show ":$2" 2>/dev/null | sed -n "${3}p") || fail "cannot read staged $2"
    [ -n "$text" ] || fail "no staged line $3 in $2"
    echo "$(line_hash "$2" "$text")  $2"
    exit 0 ;;
  *) fail "unknown option '$1' (use --worktree, --hash or nothing)" ;;
esac

# This file holds the generic patterns, so it would always match itself; it is excluded from the scan.
self_path="scripts/privacy-check.sh"

# Generic patterns: safe to publish. POSIX extended regex (no \b or \s), matched case-insensitively.
generic=(
  '[a-z0-9._%+-]+@gmail\.com'
  'ghp_[a-z0-9]{20,}'
  'github_pat_[a-z0-9_]{20,}'
  '(^|[^a-z0-9])sk-[a-z0-9_-]{20,}'
  'akia[0-9a-z]{16}'
  'BEGIN [a-z ]*PRIVATE KEY'
  '(api[_-]?key|secret[_-]?key|access[_-]?token|password)[[:space:]]*[:=]'
  '[a-z]:\\users\\'
  '/c/users/'
  '/home/[a-z0-9_-]+/'
  '(^|[^a-z])(gpu|vram|rtx|gtx|nvidia|geforce|radeon|ryzen|threadripper)([^a-z]|$)'
)

# Private patterns: must exist, be git-ignored and untracked, and hold at least one pattern.
private_file="${PRIVACY_PATTERNS:-.privacy/patterns.txt}"
[ -r "$private_file" ] || fail "private pattern list not found at $root/$private_file"
if [ -z "${PRIVACY_PATTERNS:-}" ]; then
  git check-ignore -q "$private_file" || fail "$private_file is not git-ignored; add .privacy/.gitignore containing *"
  [ -z "$(git ls-files -- "$private_file")" ] || fail "$private_file is tracked or staged; remove it with git rm --cached"
fi
private=()
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%"$cr"}"
  case "$line" in ''|'#'*) continue ;; esac
  private+=("$line")
done < "$private_file"
[ "${#private[@]}" -gt 0 ] || fail "private pattern list at $private_file has no patterns"

# Self-test: the scanner must find a known string, and must report a bad pattern as an error.
tmp=$(mktemp -d) || fail "cannot create temp dir"
trap 'rm -rf "$tmp"' EXIT
printf 'canary-7f3a\n' > "$tmp/canary.txt"
(cd "$tmp" && git grep --no-index -q -i -E -e 'canary-7f3a' -- canary.txt) >/dev/null 2>&1 \
  || fail "self-test: scanner did not find a known string"
(cd "$tmp" && git grep --no-index -q -E -e '(' -- canary.txt) >/dev/null 2>&1
[ $? -ge 2 ] || fail "self-test: a broken pattern was not reported as an error"

# Files to check, apart from this script.
if [ "$mode" = staged ]; then
  mapfile -t files < <(git ls-files --cached | grep -vxF "$self_path")
  scope=(--cached)
  what="staged content"
else
  mapfile -t files < <(git ls-files --cached --others --exclude-standard | grep -vxF "$self_path")
  scope=(--untracked)
  what="working tree, including untracked files"
fi
nfiles=${#files[@]}
[ "$nfiles" -gt 0 ] || fail "no files to check ($what)"

# Allow-list: optional, but every entry must be a well-formed hash.
allow_file=".privacy-allow"
declare -A allowed=()
if [ -e "$allow_file" ]; then
  n=0
  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n + 1)); line="${line%"$cr"}"
    case "$line" in ''|'#'*) continue ;; esac
    h="${line%%[[:space:]]*}"
    [[ "$h" =~ ^[0-9a-f]{64}$ ]] || fail "$allow_file line $n is not a SHA-256 hash: $line"
    allowed[$h]=1
  done < "$allow_file"
fi

hits=0
allowed_hits=0
run_pattern() {  # $1 = label, $2 = pattern
  local out rc kept path lineno text
  out=$(git grep "${scope[@]}" -n -I -i -E -e "$2" -- . ":(exclude)$self_path" 2>&1)
  rc=$?
  case $rc in
    0) ;;
    1) return ;;
    *) fail "pattern [$1] '$2' failed to run (exit $rc): $out" ;;
  esac
  kept=""
  while IFS=: read -r path lineno text; do
    [[ "$lineno" =~ ^[0-9]+$ ]] || fail "cannot parse match output: $path:$lineno:$text"
    if [ -n "${allowed[$(line_hash "$path" "$text")]:-}" ]; then
      allowed_hits=$((allowed_hits + 1))
    else
      kept+="    $path:$lineno:$text$nl"
    fi
  done <<< "$out"
  if [ -n "$kept" ]; then
    echo "MATCH [$1] $2"; printf '%s' "$kept"; hits=$((hits + 1))
  fi
}

for p in "${generic[@]}"; do run_pattern generic "$p"; done
for p in "${private[@]}"; do run_pattern private "$p"; done

npat=$(( ${#generic[@]} + ${#private[@]} ))
echo "privacy-check: checked $nfiles files ($what) against $npat patterns (${#generic[@]} generic, ${#private[@]} private); excluded $self_path; skipped $allowed_hits allow-listed match(es) (${#allowed[@]} entries in $allow_file)."
if [ "$hits" -gt 0 ]; then
  echo "privacy-check: FAILED: $hits pattern(s) matched. Fix the files above before committing." >&2
  exit 1
fi
echo "privacy-check: PASSED"

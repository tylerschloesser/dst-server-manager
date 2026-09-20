#!/usr/bin/env bash
# Secret guard for a PUBLIC repo. Fails if anything sensitive is about to leave this machine.
#
#   scripts/check-secrets.sh              scan every tracked + staged file
#   scripts/check-secrets.sh --pre-push   (from .githooks/pre-push) scan the commits being pushed
#
# Install once per clone:  git config core.hooksPath .githooks
set -euo pipefail

# File names that must never be tracked (anything from the DST save zip, key material, env files).
NAME_PATTERN='(^|/)(cluster_token\.txt|cluster\.ini|adminlist\.txt|TylerNi2026(/|$))|\.(zip|pem|p12|key)$|(^|/)\.env($|\.)'
NAME_ALLOW='(^|/)\.env\.example$'

# Content that must never be tracked.
CONTENT_PATTERNS=(
  'pds-g\^KU_'                                              # Klei cluster token
  'cluster_password[[:space:]]*=[[:space:]]*[^[:space:]<$]' # a real cluster password value
  'BEGIN [A-Z ]*PRIVATE KEY'
  'AKIA[0-9A-Z]{16}'
  'aws_secret_access_key[[:space:]]*[=:]'
  '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'          # anyone's email
)
# Email-shaped strings that are fine.
CONTENT_ALLOW='@dst\.ty\.ler\.dev|git@github\.com|noreply@anthropic\.com|@users\.noreply\.github\.com|@example\.(com|org)|@v[0-9]|@[0-9]+\.[0-9]'

fail=0

check_names() { # stdin: file names
  local bad
  bad=$(grep -E "$NAME_PATTERN" | grep -Ev "$NAME_ALLOW" || true)
  if [[ -n "$bad" ]]; then
    echo "check-secrets: forbidden file name(s):" >&2
    echo "$bad" | sed 's/^/  /' >&2
    fail=1
  fi
}

check_content() { # stdin: text; never echoes the matching text, only where it is
  local label=$1 text pattern hits
  text=$(cat)
  for pattern in "${CONTENT_PATTERNS[@]}"; do
    hits=$(grep -nE -e "$pattern" <<<"$text" | grep -Ev "$CONTENT_ALLOW" | cut -d: -f1 | head -5 | tr '\n' ' ' || true)
    if [[ -n "$hits" ]]; then
      echo "check-secrets: pattern /$pattern/ matched in $label (line(s): $hits)" >&2
      fail=1
    fi
  done
}

if [[ "${1:-}" != "--pre-push" ]]; then
  # Standalone: every tracked or staged file in the working tree.
  files=$( (git ls-files; git diff --cached --name-only --diff-filter=AM) | sort -u)
  check_names <<<"$files"
  while IFS= read -r f; do
    [[ -f "$f" ]] || continue
    grep -Iq . "$f" 2>/dev/null || continue # skip binary/empty
    check_content "$f" <"$f"
  done <<<"$files"
else
  # pre-push: "<local ref> <local sha> <remote ref> <remote sha>" per line on stdin.
  zero=0000000000000000000000000000000000000000
  while read -r _ local_sha _ remote_sha; do
    [[ "$local_sha" == "$zero" ]] && continue # deleting a ref
    if [[ "$remote_sha" == "$zero" ]]; then range="$local_sha"; else range="$remote_sha..$local_sha"; fi
    names=$(git log --pretty=format: --name-only --diff-filter=AMR "$range" | sort -u)
    added=$(git log -p --no-color --pretty=format: "$range" | grep -E '^\+' | grep -Ev '^\+\+\+ ' || true)
    check_names <<<"$names"
    check_content "commits $range" <<<"$added"
  done
fi

if [[ $fail -ne 0 ]]; then
  echo "check-secrets: BLOCKED. Remove the secret (and rewrite the commit if it is already committed)." >&2
  exit 1
fi
echo "check-secrets: ok"

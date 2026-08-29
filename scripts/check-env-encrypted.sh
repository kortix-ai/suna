#!/usr/bin/env bash
# Structural guard: every value in a COMMITTED .env profile must be dotenvx
# ciphertext. Run on a plain checkout — no staging area, no keys, no network.
#
# Why this exists alongside the other two secret gates:
#   - .githooks/pre-commit runs `dotenvx ext precommit`, which only inspects the
#     STAGED diff. On a fresh checkout nothing is staged, so it is a no-op in CI.
#   - secret-scan.yml (gitleaks) is PATTERN-based. It caught INTERNAL_HMAC_SECRET
#     in testing but missed a plaintext `postgres://user:password@host` URL.
# This check is STRUCTURAL: a value either starts with `encrypted:` or it fails,
# whatever the value looks like. It never prints a value, only the key name.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

mapfile -t files < <(
  git ls-files \
    | grep -E '(^|/)\.env(\.[A-Za-z0-9_-]+)?$' \
    | grep -vE '(^|/)\.env\.(example|keys)$' \
    | sort
)

if [ ${#files[@]} -eq 0 ]; then
  echo "check-env-encrypted: no tracked .env profiles found"
  exit 0
fi

fail=0
for f in "${files[@]}"; do
  n=0
  bad_in_file=0
  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n + 1))
    stripped=$(printf '%s' "$line" | sed -E 's/^[[:space:]]+//')
    case "$stripped" in
      ''|'#'*) continue ;;
    esac
    # dotenv (v16, which dotenvx uses) also parses `export KEY=VALUE`, an
    # indented line, and spaces around `=` as real values. Normalize all three
    # to a bare KEY=VALUE before deciding anything, or they slip through.
    norm=$(printf '%s' "$stripped" \
      | sed -E 's/^export[[:space:]]+//; s/^([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=[[:space:]]*/\1=/')
    if ! printf '%s' "$norm" | grep -qE '^[A-Za-z_][A-Za-z0-9_]*='; then
      # Fail closed. A non-comment line carrying '=' that this parser cannot
      # read is not proof of safety — report it instead of skipping it.
      case "$norm" in
        *=*)
          echo "UNPARSED   $f:$n  (has '=' but is not KEY=VALUE)"
          bad_in_file=$((bad_in_file + 1))
          fail=1
          ;;
      esac
      continue
    fi
    key=${norm%%=*}
    val=${norm#*=}
    val=${val#\"}; val=${val#\'}
    # dotenvx public keys are published on purpose (one per profile:
    # DOTENV_PUBLIC_KEY, _DEV, _STAGING, _PROD); empty values hold nothing.
    case "$key" in DOTENV_PUBLIC_KEY*) continue ;; esac
    case "$val" in
      ''|'"'|"'") continue ;;
      encrypted:*) continue ;;
    esac
    echo "PLAINTEXT  $f:$n  $key"
    bad_in_file=$((bad_in_file + 1))
    fail=1
  done < "$f"
  [ "$bad_in_file" -eq 0 ] && echo "ok         $f"
done

if [ "$fail" -ne 0 ]; then
  cat >&2 <<'MSG'

A committed .env profile holds a PLAINTEXT value. Do not push this.
Seal it, then re-stage:
    dotenvx encrypt -f <file> --no-armor && git add <file>
Then activate the hook so this cannot happen again:
    git config core.hooksPath .githooks
MSG
  exit 1
fi

echo "check-env-encrypted: ${#files[@]} profile(s) fully encrypted"

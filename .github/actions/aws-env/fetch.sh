#!/usr/bin/env bash
# Reads keys from AWS Secrets Manager JSON blobs and exports them to GITHUB_ENV.
# Called by action.yml; contract test: tests/unit/aws-env-action.test.ts.
#
# Input (environment):
#   AWS_ENV_KEYS    one key per line: NAME | NAME=blob:KEY, optional trailing `?`
#   AWS_ENV_REGION  Secrets Manager region
#   AWS_ENV_ACCESS_KEY_ID / _SECRET_ACCESS_KEY / _SESSION_TOKEN
#                   credentials from the OIDC step; empty = use the job's own
#   GITHUB_ENV      file the runner reads exported variables from
#
# Output: one `NAME <- blob:KEY (N chars)` line per exported key. It never
# prints a value. Every non-empty line of every value is masked first.
# Portable to bash 3.2 (macOS runners) and Git Bash (Windows runners).
set -euo pipefail

DEFAULT_BLOB="kortix-ci-env"
: "${AWS_ENV_REGION:=us-west-2}"
: "${GITHUB_ENV:?GITHUB_ENV is not set}"

if [ -n "${AWS_ENV_ACCESS_KEY_ID:-}" ]; then
  export AWS_ACCESS_KEY_ID="$AWS_ENV_ACCESS_KEY_ID"
  export AWS_SECRET_ACCESS_KEY="$AWS_ENV_SECRET_ACCESS_KEY"
  export AWS_SESSION_TOKEN="${AWS_ENV_SESSION_TOKEN:-}"
fi
unset AWS_ENV_ACCESS_KEY_ID AWS_ENV_SECRET_ACCESS_KEY AWS_ENV_SESSION_TOKEN

# Callers check this action out into .aws-env at the workflow's own commit.
# The checkout must stay until the job ends: the runner executes the POST step
# of the nested configure-aws-credentials from it. Exclude it from the job's
# repository instead, so no `git add -A` or commit can pick it up.
if [ -n "${GITHUB_WORKSPACE:-}" ] && [ -d "$GITHUB_WORKSPACE/.git/info" ]; then
  exclude="$GITHUB_WORKSPACE/.git/info/exclude"
  grep -qxF '/.aws-env/' "$exclude" 2>/dev/null || printf '/.aws-env/\n' >>"$exclude"
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Parse every line before any network call, so a typo fails without a read.
specs="$work/specs"
: >"$specs"
while IFS= read -r raw || [ -n "$raw" ]; do
  line="$(printf '%s' "$raw" | tr -d '[:space:]')"
  case "$line" in ''|'#'*) continue ;; esac
  optional=0
  case "$line" in *'?') optional=1; line="${line%\?}" ;; esac
  case "$line" in
    *=*)
      name="${line%%=*}"
      ref="${line#*=}"
      case "$ref" in
        *:*) blob="${ref%%:*}"; key="${ref#*:}" ;;
        *) echo "::error::aws-env: '$raw' must be NAME or NAME=blob:KEY"; exit 1 ;;
      esac
      ;;
    *) name="$line"; blob="$DEFAULT_BLOB"; key="$line" ;;
  esac
  if ! printf '%s' "$name" | grep -Eq '^[A-Za-z_][A-Za-z0-9_]*$' \
    || [ -z "$blob" ] || [ -z "$key" ]; then
    echo "::error::aws-env: '$raw' must be NAME or NAME=blob:KEY"
    exit 1
  fi
  printf '%s\t%s\t%s\t%s\n' "$name" "$blob" "$key" "$optional" >>"$specs"
done <<<"${AWS_ENV_KEYS:-}"

if [ ! -s "$specs" ]; then
  echo "::error::aws-env: no keys requested"
  exit 1
fi

# One GetSecretValue per distinct blob.
blob_file() { printf '%s/blob-%s.json' "$work" "$(printf '%s' "$1" | tr -c 'A-Za-z0-9_-' '_')"; }
cut -f2 "$specs" | sort -u >"$work/blobs"
while IFS= read -r blob; do
  file="$(blob_file "$blob")"
  if ! aws secretsmanager get-secret-value --region "$AWS_ENV_REGION" \
      --secret-id "$blob" --query SecretString --output text </dev/null >"$file" 2>"$work/err"; then
    echo "::error::aws-env: cannot read Secrets Manager blob '$blob' in $AWS_ENV_REGION: $(head -c 400 "$work/err")"
    exit 1
  fi
  if ! jq -e 'type == "object"' "$file" >/dev/null 2>&1; then
    echo "::error::aws-env: blob '$blob' is not a JSON object"
    exit 1
  fi
done <"$work/blobs"

random_hex() { od -An -N16 -tx1 /dev/urandom | tr -d ' \n'; }
# Windows jq writes CRLF; elsewhere a value passes through byte for byte.
strip_cr() { if [ "${RUNNER_OS:-}" = Windows ]; then tr -d '\r'; else cat; fi; }
# Workflow-command data unescapes %25, so a literal % must be sent as %25.
mask() { printf '::add-mask::%s\n' "$(printf '%s' "$1" | sed 's/%/%25/g')"; }

while IFS="$(printf '\t')" read -r name blob key optional; do
  file="$(blob_file "$blob")"
  if ! jq -e --arg k "$key" 'has($k) and .[$k] != null and ((.[$k] | tostring) | length > 0)' \
      "$file" >/dev/null; then
    if [ "$optional" = 1 ]; then
      echo "::notice::aws-env: $blob has no $key; $name left unset"
      continue
    fi
    echo "::error::aws-env: $blob has no non-empty key $key (for $name)"
    exit 1
  fi
  # Exact value: jq -r adds one newline; the sentinel keeps any trailing
  # newline of the value itself. Strings pass through; other JSON is compacted.
  value="$(jq -r --arg k "$key" '.[$k] | if type == "string" then . else tojson end' "$file" | strip_cr; printf x)"
  value="${value%x}"
  value="${value%$'\n'}"
  # Mask every line before the value can reach any log.
  while IFS= read -r l || [ -n "$l" ]; do
    if [ -n "$l" ]; then mask "$l"; fi
  done <<<"$value"
  delim="AWS_ENV_EOF_$(random_hex)"
  {
    printf '%s<<%s\n' "$name" "$delim"
    printf '%s\n' "$value"
    printf '%s\n' "$delim"
  } >>"$GITHUB_ENV"
  echo "$name <- $blob:$key (${#value} chars)"
done <"$specs"

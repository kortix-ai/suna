#!/usr/bin/env bash
# Start a new ledger entry and add it to MEMORY.md.
#
#   new-entry.sh "<the rule, as an imperative>" [incident-date YYYY-MM-DD]
#
# Creates entries/<YYYY-MM-DDTHHMMSSZ>-<slug>.md stamped with the current UTC
# time, prints its path, and rebuilds the index. Fill in the four sections,
# then commit the entry and MEMORY.md together.
set -euo pipefail

title="${1:-}"
incident="${2:-$(date -u +%F)}"
if [ -z "$title" ]; then
  echo "usage: $0 \"<the rule, as an imperative>\" [incident-date YYYY-MM-DD]" >&2
  exit 1
fi
if ! [[ "$incident" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
  echo "incident date must be YYYY-MM-DD, got '${incident}'" >&2
  exit 1
fi

dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
now="$(date -u +%s)"
stamp="$(date -u -r "$now" +%Y-%m-%dT%H%M%SZ 2>/dev/null || date -u -d "@$now" +%Y-%m-%dT%H%M%SZ)"
recorded="$(date -u -r "$now" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@$now" +%Y-%m-%dT%H:%M:%SZ)"
slug="$(printf '%s' "$title" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//' | cut -c1-60 | sed -E 's/-+$//')"
file="$dir/entries/${stamp}-${slug}.md"

if [ -e "$file" ]; then
  echo "${file} already exists" >&2
  exit 1
fi

mkdir -p "$dir/entries"
cat >"$file" <<EOF
---
recorded: ${recorded}
incident_date: ${incident}
---
# ${title}

**Rule:** <the imperative a developer can obey while coding>

**Trigger surface:** <what someone is doing when this applies>

**Incident:** <date, version or PR, blast radius; synthetic identifiers only>

**Enforcement:** <the test, lint, or CI gate that goes red when the rule breaks, or "none yet: <the enforcer to build>">
EOF

"$dir/scripts/index.sh"
echo "$file"

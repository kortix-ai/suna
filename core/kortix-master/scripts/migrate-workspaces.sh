#!/bin/bash
set -u
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB_PATH="${KORTIX_DB_PATH:-/workspace/.kortix/kortix.db}"
PROJECT_ROOT="${KORTIX_PROJECT_ROOT:-/srv/kortix/projects}"
SUPERVISOR_SOCK="${KORTIX_SUPERVISOR_SOCKET:-/run/kortix/supervisor.sock}"
BUN_BIN="${BUN_BIN:-/opt/bun/bin/bun}"
[ -x "$BUN_BIN" ] || BUN_BIN="$(command -v bun || true)"

log() { echo "[migrate-workspaces] $*"; }

if [ "$(id -u)" -ne 0 ]; then
  log "must run as root (got uid=$(id -u))"
  exit 1
fi

if [ -z "$BUN_BIN" ] || [ ! -x "$BUN_BIN" ]; then
  log "bun not available; skipping"
  exit 0
fi

if [ ! -f "$DB_PATH" ]; then
  log "no kortix.db at $DB_PATH; nothing to migrate"
  exit 0
fi

if [ ! -S "$SUPERVISOR_SOCK" ]; then
  log "supervisor socket not present at $SUPERVISOR_SOCK; is svc-opencode-supervisor up?"
  exit 1
fi

mkdir -p "$PROJECT_ROOT"
chmod 755 "$PROJECT_ROOT"

ROWS="$("$BUN_BIN" -e "
import { Database } from 'bun:sqlite'
const db = new Database('${DB_PATH}', { readonly: true })
const projects = db.query('SELECT id, path FROM projects').all()
for (const p of projects) {
  const members = db.prepare('SELECT pm.user_id, um.linux_uid, um.username FROM project_members pm JOIN supabase_uid_map um ON um.supabase_user_id = pm.user_id WHERE pm.project_id = ?').all(p.id)
  const membersJson = JSON.stringify(members)
  process.stdout.write(p.id + '\t' + (p.path ?? '') + '\t' + membersJson + '\n')
}
" 2>/dev/null || true)"

if [ -z "$ROWS" ]; then
  log "no projects to migrate"
  exit 0
fi

count=0
skipped=0
while IFS=$'\t' read -r project_id legacy_path members_json; do
  [ -z "$project_id" ] && continue

  if [ "$legacy_path" = "/workspace" ] || [ -z "$legacy_path" ]; then
    log "skip $project_id: legacy path='$legacy_path' is workspace root"
    skipped=$((skipped + 1))
    continue
  fi

  target_dir="$PROJECT_ROOT/$project_id"

  body=$(printf '{"project_id":"%s","migrate_from":"%s","members":%s}' "$project_id" "$legacy_path" "$members_json")
  resp=$(curl --silent --unix-socket "$SUPERVISOR_SOCK" \
    -X POST -H 'content-type: application/json' \
    -d "$body" \
    "http://supervisor/project/ensure")

  if echo "$resp" | grep -q '"path"'; then
    log "ok project=$project_id legacy=$legacy_path -> $target_dir"
    count=$((count + 1))
  else
    log "FAIL project=$project_id: $resp"
  fi
done <<< "$ROWS"

log "migrated $count project(s), skipped $skipped"

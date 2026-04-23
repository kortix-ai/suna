#!/bin/bash
set -u
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB_PATH="${KORTIX_DB_PATH:-/workspace/.kortix/kortix.db}"
HOME_ROOT="${KORTIX_MEMBER_HOME_ROOT:-/srv/kortix/home}"
UID_MIN="${KORTIX_MEMBER_UID_MIN:-10000}"
UID_MAX="${KORTIX_MEMBER_UID_MAX:-19999}"
DUMP_SCRIPT="$SCRIPT_DIR/dump-uid-map.ts"
BUN_BIN="${BUN_BIN:-/opt/bun/bin/bun}"
[ -x "$BUN_BIN" ] || BUN_BIN="$(command -v bun || true)"

log() { echo "[provision-members] $*"; }

if [ "$(id -u)" -ne 0 ]; then
  log "must run as root (got uid=$(id -u))"
  exit 0
fi

if [ -z "$BUN_BIN" ] || [ ! -x "$BUN_BIN" ]; then
  log "bun not available; skipping"
  exit 0
fi

if [ ! -f "$DUMP_SCRIPT" ]; then
  log "dump script missing at $DUMP_SCRIPT; skipping"
  exit 0
fi

if [ ! -f "$DB_PATH" ]; then
  log "no kortix.db yet at $DB_PATH; skipping"
  exit 0
fi

mkdir -p "$HOME_ROOT"
chmod 755 "$HOME_ROOT"

ROWS="$(KORTIX_DB_PATH="$DB_PATH" "$BUN_BIN" run "$DUMP_SCRIPT" 2>/dev/null || true)"

if [ -z "$ROWS" ]; then
  log "no rows to provision"
  exit 0
fi

count=0
while IFS=$'\t' read -r supabase_user_id linux_uid username primary_gid; do
  [ -z "$username" ] && continue
  [ -z "$linux_uid" ] && continue

  if [ "$linux_uid" -lt "$UID_MIN" ] || [ "$linux_uid" -gt "$UID_MAX" ]; then
    log "skip $username: uid $linux_uid out of range [$UID_MIN, $UID_MAX]"
    continue
  fi

  home_dir="$HOME_ROOT/$username"

  if ! getent group "$primary_gid" >/dev/null 2>&1; then
    groupadd --gid "$primary_gid" "$username" || { log "groupadd failed for $username"; continue; }
  fi

  if ! id "$username" >/dev/null 2>&1; then
    useradd --uid "$linux_uid" --gid "$primary_gid" --no-create-home \
            --home-dir "$home_dir" --shell /bin/bash "$username" \
      || { log "useradd failed for $username"; continue; }
  fi

  mkdir -p "$home_dir" "$home_dir/.kortix" "$home_dir/projects" "$home_dir/.config" "$home_dir/.config/opencode"
  chown -R "$linux_uid:$primary_gid" "$home_dir"
  chmod 700 "$home_dir" "$home_dir/.kortix" "$home_dir/projects" "$home_dir/.config" "$home_dir/.config/opencode"

  count=$((count + 1))
  log "ok user=$username uid=$linux_uid supabase=$supabase_user_id"
done <<< "$ROWS"

log "provisioned $count member(s)"

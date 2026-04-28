#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Container entrypoint — boots s6-overlay directly.
#
# PERSISTENCE MODEL:
#   /workspace/   = PERSISTENT USER WORKSPACE (projects, repos, user files)
#   /persistent/  = PERSISTENT SYSTEM STATE   (OpenCode DB, secrets, browser state)
#                   Backed by /workspace/.persistent-system so it survives every
#                   restart/recreate without depending on host-level extra mounts.
#   /opt/         = EPHEMERAL RUNTIME         (image layer — replaced on update)
#   /run/s6/      = EPHEMERAL TMPFS           (rebuilt from persistent secrets)
#
# On boot, this script:
#   1. Ensures all persistent dirs exist under /workspace/
#   2. Migrates legacy layouts (symlinks → real dirs)
#   3. Fixes file ownership for the abc user
#   4. Cleans stale locks/WAL files from previous container
#   5. Hands off to s6-overlay (/init)
#
# The s6 init scripts then:
#   - Restore secrets → s6 env dir (97-secrets-to-s6-env.sh)
#   - Set up git, tool deps, env guards (98-kortix-env.sh)
#   - Restore user-installed apt/pip/npm packages (99-restore-packages.sh)
# ─────────────────────────────────────────────────────────────────────────────

set -e

# Resolve abc's actual UID/GID — never assume 1000.
# The linuxserver base image creates abc with UID 911, not 1000.
WORKSPACE_UID="$(id -u abc 2>/dev/null || echo 911)"
WORKSPACE_GID="$(id -g abc 2>/dev/null || echo 911)"

echo "[startup] Preparing Kortix sandbox..."

export KORTIX_PERSISTENT_ROOT=/persistent
export OPENCODE_STORAGE_BASE="${OPENCODE_STORAGE_BASE:-${KORTIX_PERSISTENT_ROOT}/opencode}"
export OPENCODE_SHADOW_STORAGE_BASE="${OPENCODE_SHADOW_STORAGE_BASE:-${KORTIX_PERSISTENT_ROOT}/opencode-shadow}"
export KORTIX_OPENCODE_ARCHIVE_DIR="${KORTIX_OPENCODE_ARCHIVE_DIR:-${KORTIX_PERSISTENT_ROOT}/opencode-archive}"
export KORTIX_OPENCODE_CACHE_DIR="${KORTIX_OPENCODE_CACHE_DIR:-${KORTIX_PERSISTENT_ROOT}/opencode-cache}"
export SECRET_FILE_PATH="${SECRET_FILE_PATH:-${KORTIX_PERSISTENT_ROOT}/secrets/.secrets.json}"
export SALT_FILE_PATH="${SALT_FILE_PATH:-${KORTIX_PERSISTENT_ROOT}/secrets/.salt}"
export ENCRYPTION_KEY_PATH="${ENCRYPTION_KEY_PATH:-${KORTIX_PERSISTENT_ROOT}/secrets/.encryption-key}"
export AUTH_JSON_PATH="${AUTH_JSON_PATH:-${OPENCODE_STORAGE_BASE}/auth.json}"
export LSS_DIR="${LSS_DIR:-${KORTIX_PERSISTENT_ROOT}/lss}"
export KORTIX_BROWSER_PROFILE_DIR="${KORTIX_BROWSER_PROFILE_DIR:-${KORTIX_PERSISTENT_ROOT}/browser-profile}"
export KORTIX_AGENT_BROWSER_DIR="${KORTIX_AGENT_BROWSER_DIR:-${KORTIX_PERSISTENT_ROOT}/agent-browser}"
export KORTIX_KORTIX_STATE_DIR="${KORTIX_KORTIX_STATE_DIR:-${KORTIX_PERSISTENT_ROOT}/kortix-state}"
export KORTIX_XDG_DIR="${KORTIX_XDG_DIR:-${KORTIX_PERSISTENT_ROOT}/xdg}"

PERSIST_BACKING_DIR="/workspace/.persistent-system"
mkdir -p "$PERSIST_BACKING_DIR"
if [ -L "$KORTIX_PERSISTENT_ROOT" ]; then
  if [ "$(readlink "$KORTIX_PERSISTENT_ROOT" 2>/dev/null || true)" != "$PERSIST_BACKING_DIR" ]; then
    rm -f "$KORTIX_PERSISTENT_ROOT"
    ln -s "$PERSIST_BACKING_DIR" "$KORTIX_PERSISTENT_ROOT"
  fi
elif [ -d "$KORTIX_PERSISTENT_ROOT" ] && [ -z "$(ls -A "$KORTIX_PERSISTENT_ROOT" 2>/dev/null)" ]; then
  rmdir "$KORTIX_PERSISTENT_ROOT" 2>/dev/null || true
  ln -s "$PERSIST_BACKING_DIR" "$KORTIX_PERSISTENT_ROOT"
elif [ ! -e "$KORTIX_PERSISTENT_ROOT" ]; then
  ln -s "$PERSIST_BACKING_DIR" "$KORTIX_PERSISTENT_ROOT"
fi

migrate_dir_to_persistent() {
  local legacy="$1"
  local target="$2"

  if [ "$legacy" = "$target" ]; then
    if [ -L "$legacy" ] && [ "$(readlink "$legacy" 2>/dev/null || true)" = "$legacy" ]; then
      rm -f "$legacy"
    fi
    mkdir -p "$target"
    return
  fi

  mkdir -p "$(dirname "$legacy")" "$target"

  if [ -L "$legacy" ]; then
    local link_target
    link_target=$(readlink "$legacy" 2>/dev/null || true)
    if [ -n "$link_target" ] && [ "$link_target" != "$target" ] && [ -d "$link_target" ]; then
      cp -a "$link_target"/. "$target"/ 2>/dev/null || true
    fi
    rm -f "$legacy"
  elif [ -d "$legacy" ]; then
    cp -a "$legacy"/. "$target"/ 2>/dev/null || true
    rm -rf "$legacy"
  fi

  ln -s "$target" "$legacy"
}

# ── Persistent dirs (workspace + system state) ───────────────────────────────
mkdir -p \
  /workspace/.local/bin \
  /workspace/.local/share \
  /workspace/.local/lib \
  /workspace/.cache \
  /workspace/.npm-global/bin \
  /workspace/.npm-global/lib \
  /workspace/.kortix \
  /workspace/.kortix/packages \
  /workspace/.config \
  /workspace/.opencode \
  /workspace/.opencode/skills \
  /workspace/.ocx

mkdir -p \
  "$OPENCODE_STORAGE_BASE" \
  "$OPENCODE_STORAGE_BASE/log" \
  "$OPENCODE_STORAGE_BASE/storage" \
  "$OPENCODE_STORAGE_BASE/snapshot" \
  "$OPENCODE_STORAGE_BASE/tool-output" \
  "$OPENCODE_STORAGE_BASE/plugins" \
  "$OPENCODE_STORAGE_BASE/workspace" \
  "$OPENCODE_STORAGE_BASE/delegations" \
  "$OPENCODE_SHADOW_STORAGE_BASE" \
  "$KORTIX_OPENCODE_ARCHIVE_DIR" \
  "$KORTIX_OPENCODE_CACHE_DIR" \
  "$(dirname "$SECRET_FILE_PATH")" \
  "$LSS_DIR" \
  "$KORTIX_BROWSER_PROFILE_DIR" \
  "$KORTIX_AGENT_BROWSER_DIR" \
  "$KORTIX_KORTIX_STATE_DIR" \
  "$KORTIX_XDG_DIR"

migrate_dir_to_persistent /workspace/.local/share/opencode "$OPENCODE_STORAGE_BASE"
migrate_dir_to_persistent /workspace/.cache/opencode "$KORTIX_OPENCODE_CACHE_DIR"
migrate_dir_to_persistent /workspace/.secrets "$(dirname "$SECRET_FILE_PATH")"
migrate_dir_to_persistent /workspace/.lss "$LSS_DIR"
migrate_dir_to_persistent /workspace/.browser-profile "$KORTIX_BROWSER_PROFILE_DIR"
migrate_dir_to_persistent /workspace/.agent-browser "$KORTIX_AGENT_BROWSER_DIR"
migrate_dir_to_persistent /workspace/.kortix-state "$KORTIX_KORTIX_STATE_DIR"
migrate_dir_to_persistent /workspace/.XDG "$KORTIX_XDG_DIR"

# ── Migrate legacy symlinks to real dirs ────────────────────────────────────
# Old images created /workspace/.opencode as a symlink to /workspace/.kortix/.opencode.
# New model: /workspace/.opencode IS the real dir. Migrate data if needed.
if [ -L /workspace/.opencode ]; then
  LINK_TARGET=$(readlink /workspace/.opencode 2>/dev/null || true)
  echo "[startup] Migrating .opencode from symlink ($LINK_TARGET) to real dir..."
  rm -f /workspace/.opencode
  mkdir -p /workspace/.opencode/skills
  # Copy data from old location if it exists
  if [ -d "$LINK_TARGET" ]; then
    cp -a "$LINK_TARGET"/. /workspace/.opencode/ 2>/dev/null || true
  fi
fi

chmod 700 "$(dirname "$SECRET_FILE_PATH")" 2>/dev/null || true

# ── Convenience symlink: opencode → .opencode ───────────────────────────────
# Visible, discoverable alias for users who don't know to look for dotfiles.
# Migrate legacy "OpenCodeConfig" symlink to the shorter "opencode" name.
if [ -L /workspace/OpenCodeConfig ]; then
  rm -f /workspace/OpenCodeConfig
fi
if [ ! -e /workspace/opencode ] && [ ! -L /workspace/opencode ]; then
  ln -s /workspace/.opencode /workspace/opencode
fi

# ── Exclude opencode internal dirs from git (prevents 16K+ snapshot diffs) ──
# Only refresh info/exclude when the git repo already exists (container restart).
# For fresh workspaces, kortix-env-setup.sh writes info/exclude AFTER git init
# (git init overwrites info/exclude with its default template, so writing it here
# on fresh repos is pointless — it gets clobbered).
if [ -f /workspace/.git/HEAD ]; then
  mkdir -p /workspace/.git/info 2>/dev/null || true
  cat > /workspace/.git/info/exclude << 'GITEXCLUDE'
# opencode internal data — never include in snapshot diffs
.local/share/opencode/
.persistent-system/
.cache/
.config/
.opencode/
.kortix/
.kortix-state/
.secrets/
.browser-profile/
.agent-browser/
.lss/
.ocx/
.XDG/
.bun/
.npm-global/
.npm/
.dbus/
.pki/
.ssh/
ssl/
opencode
GITEXCLUDE
fi

# ── Clean stale browser locks ───────────────────────────────────────────────
# After unclean shutdown, Chromium singletons prevent agent-browser from starting.
rm -f /workspace/.browser-profile/SingletonLock \
     /workspace/.browser-profile/SingletonCookie \
     /workspace/.browser-profile/SingletonSocket 2>/dev/null

# ── Clean stale legacy dirs ─────────────────────────────────────────────────
# ssl/ was created by old images but never used by anything. Remove if empty.
[ -d /workspace/ssl ] && [ -z "$(ls -A /workspace/ssl 2>/dev/null)" ] && rmdir /workspace/ssl 2>/dev/null || true

# ── Fix ownership (critical after Docker image updates) ─────────────────────
# When a container is recreated from a new image, the abc user UID may differ
# from the previous image. Fix ALL workspace files to match the current abc user.
echo "[startup] Fixing workspace ownership..."
chown -R "$WORKSPACE_UID:$WORKSPACE_GID" /workspace 2>/dev/null || true
chmod 700 "$(dirname "$SECRET_FILE_PATH")" 2>/dev/null || true

# Also fix /opt dirs — the Dockerfile chowns these to abc:abc at build time,
# but if the image was built with an older Dockerfile that used 1000:1000,
# this ensures they are corrected at runtime too.
chown -R "$WORKSPACE_UID:$WORKSPACE_GID" \
  /ephemeral \
  2>/dev/null || true

# ── Initialize ocx (marketplace CLI) ────────────────────────────────────────
# Runs AFTER chown so all files ocx creates are owned by abc, not root.
# This prevents EACCES errors when the frontend PTY runs 'ocx add' as abc.
if command -v ocx >/dev/null 2>&1; then
  if [ ! -f /workspace/.opencode/ocx.jsonc ]; then
    echo "[startup] Running ocx init..."
    su -s /bin/sh abc -c 'ocx init --cwd /workspace' 2>/dev/null || echo "[startup] WARNING: ocx init failed (non-fatal)"
  fi

  # ── Fix malformed opencode.jsonc generated during bootstrap ─────────────────
  # We have seen two broken starter templates in the wild:
  #   1. missing comma after "$schema"
  #   2. an over-escaped "\$schema" key written by our old repair path
  # Both break OpenCode config loading. Only rewrite the known bad templates so
  # we do not clobber legitimate user config.
  OPENCODE_USER_CONFIG="/workspace/.opencode/opencode.jsonc"
  if [ -f "$OPENCODE_USER_CONFIG" ]; then
    if grep -q '\\\$schema' "$OPENCODE_USER_CONFIG" 2>/dev/null \
       || { grep -qF '// Add MCP servers' "$OPENCODE_USER_CONFIG" 2>/dev/null \
            && ! grep -v '^[[:space:]]*//' "$OPENCODE_USER_CONFIG" | grep -q ',' 2>/dev/null; }; then
      echo "[startup] Repairing malformed opencode.jsonc template..."
      su -s /bin/sh abc -c 'python3 - "$1"' _ "$OPENCODE_USER_CONFIG" <<'PY' || echo "[startup] WARNING: opencode.jsonc repair failed (non-fatal)"
import sys
from pathlib import Path
path = Path(sys.argv[1])
text = path.read_text()

text = text.replace('"\\$schema"', '"$schema"')

if '// Add MCP servers' in text:
    lines = text.splitlines()
    repaired = []
    for i, line in enumerate(lines):
        stripped = line.strip()
        next_nonempty = ''
        for candidate in lines[i + 1:]:
            if candidate.strip():
                next_nonempty = candidate.strip()
                break
        if stripped.startswith('"$schema"') and not stripped.endswith(',') and next_nonempty.startswith('//'):
            repaired.append(line + ',')
            continue
        repaired.append(line)
    text = '\n'.join(repaired) + ('\n' if text.endswith('\n') else '')

path.write_text(text)
PY
    fi
  fi
  # Always ensure registry aliases exist (idempotent)
  su -s /bin/sh abc -c 'ocx registry add https://master.kortix-registry.pages.dev --name kortix --cwd /workspace -q' 2>/dev/null || true
  su -s /bin/sh abc -c 'ocx registry add https://registry.kdco.dev --name kdco --cwd /workspace -q' 2>/dev/null || true
fi

# ── Clean stale sqlite WAL/SHM files ────────────────────────────────────────
# After container recreate, sqlite WAL/SHM files from the old container can
# cause "readonly database" errors. Remove them so sqlite recreates cleanly.
find "$OPENCODE_STORAGE_BASE" -name "*.db-wal" -o -name "*.db-shm" 2>/dev/null | while read f; do
  echo "[startup] Removing stale sqlite file: $f"
  rm -f "$f"
done

if command -v kortix-opencode-state >/dev/null 2>&1; then
  kortix-opencode-state guard >/dev/null 2>&1 || true
  kortix-opencode-state sync >/dev/null 2>&1 || true
fi

# ── Stale LSS database cleanup ───────────────────────────────────────────────
if [ -f "$LSS_DIR/lss.db" ]; then
  LSS_OWNER=$(stat -c '%u' "$LSS_DIR/lss.db" 2>/dev/null || echo "unknown")
  if [ "$LSS_OWNER" != "$WORKSPACE_UID" ] && [ "$LSS_OWNER" != "unknown" ]; then
    echo "[startup] Removing stale LSS database (owned by UID $LSS_OWNER, expected $WORKSPACE_UID)"
    rm -f "$LSS_DIR/lss.db" "$LSS_DIR/lss.db-wal" "$LSS_DIR/lss.db-shm"
  fi
fi

# ── /config symlink (linuxserver base image compat) ─────────────────────────
if [ ! -L /config ] && [ ! -d /config ]; then
  ln -s /workspace /config
fi

# ── Verify runtime exists ───────────────────────────────────────────────────
if [ ! -e /ephemeral/kortix-master ]; then
  echo "[startup] WARNING: /ephemeral/kortix-master not found! Rebuild the Docker image."
fi

# ── Self-heal kortix.db schema ──────────────────────────────────────────────
# Older images shipped a `projects` table without `structure_version` /
# `user_handle`. Without the column, every project an old master inserts is
# implicitly v1 (no default) and every read defaults to v1, so newly created
# projects act like the legacy task layout. Add the columns here BEFORE s6
# starts kortix-master, so the master always sees a v2-capable schema even
# if its own bundled code is stale. NOT NULL DEFAULT 2 means every insert
# the master does — even one that doesn't list the column — gets v2.
KORTIX_DB="/workspace/.kortix/kortix.db"
if [ -f "$KORTIX_DB" ] && command -v python3 >/dev/null 2>&1; then
  python3 - "$KORTIX_DB" <<'PYEOF' || echo "[startup] kortix.db migration skipped (best-effort)"
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
def add(sql):
    try: db.execute(sql); db.commit()
    except sqlite3.OperationalError: pass  # column already exists
add("ALTER TABLE projects ADD COLUMN structure_version INTEGER NOT NULL DEFAULT 2")
add("ALTER TABLE projects ADD COLUMN user_handle TEXT")
try:
    upgraded = db.execute(
        "UPDATE projects SET structure_version=2 WHERE structure_version<2 AND id<>'proj-workspace'"
    ).rowcount
    db.commit()
    if upgraded:
        print(f"[startup] kortix.db: upgraded {upgraded} legacy v1 project(s) to v2")
except sqlite3.OperationalError:
    pass
db.close()
PYEOF
fi

# ── Install Kortix CLI wrappers ─────────────────────────────────────────────
# Runtime-facing commands (ktelegram/kslack/kchannel/kconnectors/kpipedream)
# should always resolve from immutable /ephemeral code, never /workspace.
if [ -x /ephemeral/kortix-master/scripts/install-channel-clis.sh ]; then
  /ephemeral/kortix-master/scripts/install-channel-clis.sh || echo "[startup] WARNING: channel CLI install failed"
fi

echo "[startup] Starting s6-overlay directly..."

# Docker-in-Docker must work by default. Running the whole sandbox inside an
# extra nested PID namespace via `unshare --pid --fork /init` breaks nested
# dockerd/containerd shim startup with errors like:
#   open /proc/<pid>/oom_score_adj: no such file or directory
# So the sandbox always starts s6 in the container's primary PID namespace.
exec /init

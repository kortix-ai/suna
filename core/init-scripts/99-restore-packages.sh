#!/usr/bin/with-contenv bash
# Restore user-installed packages after container update/recreate.
#
# The /workspace volume persists but the container layer is ephemeral.
# This script re-installs packages that were saved to manifests by the
# persistence wrappers (apt-persist, pip, npm -g).
#
# Runs AFTER all other init scripts (99 = last).
# Designed to be idempotent and non-fatal — a failed restore doesn't
# block container boot.

echo "[restore-packages] Checking for packages to restore..."

MANIFEST_DIR="/workspace/.kortix/packages"
mkdir -p "$MANIFEST_DIR"

RESTORED=0

# ── 1. Restore apt packages ─────────────────────────────────────────────────
APT_MANIFEST="$MANIFEST_DIR/apt-packages.txt"
LEGACY_APK_MANIFEST="$MANIFEST_DIR/apk-packages.txt"
LEGACY_APK_UNMAPPED="$MANIFEST_DIR/apk-packages.unmapped.txt"
APT_READY=0

apt_prepare() {
  if [ "$APT_READY" -eq 1 ]; then
    return 0
  fi
  if ! command -v apt-get >/dev/null 2>&1; then
    echo "[restore-packages] WARNING: apt-get not found — skipping system package restore"
    return 1
  fi
  export DEBIAN_FRONTEND=noninteractive
  if apt-get update >/dev/null 2>&1; then
    APT_READY=1
    return 0
  fi
  echo "[restore-packages] WARNING: apt-get update failed (non-fatal)"
  return 1
}

if [ -s "$APT_MANIFEST" ]; then
  echo "[restore-packages] Restoring apt packages..."
  if apt_prepare; then
    PKGS=$(tr '\n' ' ' < "$APT_MANIFEST")
    if apt-get install -y --no-install-recommends $PKGS >/dev/null 2>&1; then
      RESTORED=$((RESTORED + $(wc -l < "$APT_MANIFEST")))
      echo "[restore-packages] apt: restored $(wc -l < "$APT_MANIFEST") package(s)"
    else
      echo "[restore-packages] WARNING: some apt packages failed to install (non-fatal)"
    fi
  fi
fi

if [ -s "$LEGACY_APK_MANIFEST" ]; then
  echo "[restore-packages] Found legacy apk manifest — attempting one-time migration to apt"
  : > "$LEGACY_APK_UNMAPPED"
  touch "$APT_MANIFEST"
  if apt_prepare; then
    while IFS= read -r pkg || [ -n "$pkg" ]; do
      [ -n "$pkg" ] || continue
      if grep -qxF "$pkg" "$APT_MANIFEST" 2>/dev/null; then
        continue
      fi
      if apt-get install -y --no-install-recommends "$pkg" >/dev/null 2>&1; then
        echo "$pkg" >> "$APT_MANIFEST"
        RESTORED=$((RESTORED + 1))
        echo "[restore-packages] migrated '$pkg' into apt manifest"
      else
        echo "$pkg" >> "$LEGACY_APK_UNMAPPED"
      fi
    done < "$LEGACY_APK_MANIFEST"
    if [ -s "$LEGACY_APK_UNMAPPED" ]; then
      echo "[restore-packages] WARNING: some legacy apk package names do not exist on Ubuntu. Review $LEGACY_APK_UNMAPPED"
    else
      rm -f "$LEGACY_APK_UNMAPPED"
    fi
  fi
fi

# ── 2. Restore pip packages ─────────────────────────────────────────────────
# pip packages installed with PIP_USER=1 already live in /workspace/.local/
# which persists. But if someone did a manual `pip install --user` before
# the ENV was set, the packages are already there. Nothing to restore.
# We just ensure the bin dir is correct.
if [ -d /workspace/.local/lib/python*/site-packages ]; then
  echo "[restore-packages] pip: user packages found in /workspace/.local/ (persisted via volume)"
fi

# ── 3. Restore npm global packages ──────────────────────────────────────────
# npm -g packages installed with NPM_CONFIG_PREFIX=/workspace/.npm-global
# already persist in the volume. Nothing to restore — just verify.
if [ -d /workspace/.npm-global/lib/node_modules ] && [ "$(ls -A /workspace/.npm-global/lib/node_modules 2>/dev/null)" ]; then
  NPM_COUNT=$(ls -1 /workspace/.npm-global/lib/node_modules | wc -l)
  echo "[restore-packages] npm: $NPM_COUNT global package(s) found in /workspace/.npm-global/ (persisted via volume)"
fi

# ── 4. Inject persistent PATH into s6 environment ───────────────────────────
# s6 services inherit env from /run/s6/container_environment/. We need to
# ensure the persistent bin dirs are in PATH for ALL services, not just
# login shells.
CURRENT_PATH=$(cat /run/s6/container_environment/PATH 2>/dev/null || echo "")
if [ -n "$CURRENT_PATH" ]; then
  # Only add if not already present
  case "$CURRENT_PATH" in
    */workspace/.npm-global/bin*) ;;
    *) CURRENT_PATH="/workspace/.npm-global/bin:$CURRENT_PATH" ;;
  esac
  case "$CURRENT_PATH" in
    */workspace/.local/bin*) ;;
    *) CURRENT_PATH="/workspace/.local/bin:$CURRENT_PATH" ;;
  esac
  printf '%s' "$CURRENT_PATH" > /run/s6/container_environment/PATH
  echo "[restore-packages] PATH updated for s6 services"
fi

# ── 5. Fix ownership of persistent package dirs ─────────────────────────────
# Use abc's actual UID — never hardcode 1000.
WORKSPACE_UID="$(id -u abc 2>/dev/null || echo 911)"
WORKSPACE_GID="$(id -g abc 2>/dev/null || echo 911)"
chown -R "$WORKSPACE_UID:$WORKSPACE_GID" \
  /workspace/.local \
  /workspace/.npm-global \
  /workspace/.kortix/packages \
  2>/dev/null || true

if [ $RESTORED -gt 0 ]; then
  echo "[restore-packages] Restored $RESTORED package(s) total."
else
  echo "[restore-packages] No packages to restore."
fi

if [ "$APT_READY" -eq 1 ]; then
  rm -rf /var/lib/apt/lists/* 2>/dev/null || true
fi

#!/usr/bin/with-contenv bash
# Fix ownership for ALL directories that abc (UID 911) needs to write to.
#
# The linuxserver base image creates user abc with UID 911, NOT 1000.
# Various init scripts and the base image itself may chown things to
# PUID:PGID (default 1000:1000), which breaks runtime writes.
#
# This script runs LAST (zz- prefix in /custom-cont-init.d/) and
# ensures abc owns everything it needs.

ABC_UID="$(id -u abc 2>/dev/null || echo 911)"
ABC_GID="$(id -g abc 2>/dev/null || echo 911)"

echo "[fix-ownership] Fixing all abc-owned dirs (UID=$ABC_UID GID=$ABC_GID)..."

# /workspace subdirs that abc writes to at runtime
chown -R "$ABC_UID:$ABC_GID" \
  /workspace/.local \
  /workspace/.cache \
  /workspace/.bun \
  /workspace/.config \
  /workspace/.opencode \
  /workspace/.kortix \
  /workspace/.kortix-state \
  /workspace/.secrets \
  /workspace/.npm-global \
  /workspace/.XDG \
  /workspace/.browser-profile \
  /workspace/.lss \
  /workspace/.ocx \
  /workspace/.persistent-system \
  /persistent \
  /workspace/.git \
  2>/dev/null || true

# /ephemeral dirs — shipped runtime that abc may need to write into (plugin caches, etc.)
chown -R "$ABC_UID:$ABC_GID" \
  /ephemeral \
  2>/dev/null || true

echo "[fix-ownership] Done."

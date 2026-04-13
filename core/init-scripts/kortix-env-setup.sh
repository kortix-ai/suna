#!/usr/bin/with-contenv bash
# Kortix environment setup — minimal version
# Just sets up the Kortix token for passthrough billing, no URL rewriting

# ── Git identity ──────────────────────────────────────────────────────────────
# Required for createProject() git commits and OpenCode project discovery.
# Without this, `git commit` fails silently in sandboxes → repos have no commits
# → OpenCode can't derive a project ID → everything falls back to "global".
if ! git config --global user.email >/dev/null 2>&1; then
    git config --global user.email "agent@kortix.ai"
    git config --global user.name "Kortix Agent"
    echo "[Kortix] Git identity configured"
fi

# ── Workspace git init ────────────────────────────────────────────────────────
# /workspace/ is the main workspace root. Init it as a git repo so OpenCode
# resolves a real project ID instead of falling back to id="global".
if [ ! -d /workspace/.git ] || [ -z "$(git -C /workspace rev-list --max-parents=0 --all 2>/dev/null)" ]; then
    cd /workspace
    # Use .git/HEAD as the real indicator — startup.sh pre-creates .git/info/
    # which makes `[ ! -d .git ]` return false even when git init hasn't run.
    [ ! -f .git/HEAD ] && git init

    # Write info/exclude HERE — after git init — because git init overwrites
    # info/exclude with its default template, clobbering anything written earlier
    # (e.g. by startup.sh). The .gitignore baked into the image is the primary
    # guard; info/exclude is belt-and-suspenders.
    mkdir -p /workspace/.git/info
    cat > /workspace/.git/info/exclude << 'GITEXCLUDE'
# kortix/opencode internal dirs — never include in snapshot diffs
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

    # Ensure at least one commit exists (OpenCode needs root commit for project ID)
    if [ -z "$(git rev-list --max-parents=0 --all 2>/dev/null)" ]; then
        # Stage .kortix, .opencode, and .gitignore — .gitignore commits the
        # snapshot exclusions so they're always respected, even without info/exclude.
        git add .kortix .opencode .gitignore 2>/dev/null || true
        git commit --allow-empty -m "Workspace init" >/dev/null 2>&1
    fi
    chown -R abc:users /workspace/.git 2>/dev/null || true
    echo "[Kortix] Workspace git repo initialized"
fi

# ── Untrack excluded dirs from git index ─────────────────────────────────────
# If any excluded dirs were accidentally committed before exclusions were set up
# (e.g. old image, volume from previous version), remove them from the index.
# This is a no-op if they were never tracked.
git -C /workspace rm --cached -r --ignore-unmatch \
    .browser-profile .local/share/opencode .cache/opencode \
    .persistent-system \
    .bun .npm-global .lss .ocx .XDG \
    >/dev/null 2>&1 || true

# ── Dev server crash protection ─────────────────────────────────────────────
GUARD_PATH="/ephemeral/kortix-master/econnreset-guard.cjs"
if [ -f "$GUARD_PATH" ]; then
    EXISTING_NODE_OPTIONS="${NODE_OPTIONS:-}"
    if echo "$EXISTING_NODE_OPTIONS" | grep -q "$GUARD_PATH" 2>/dev/null; then
        echo "[Kortix] NODE_OPTIONS ECONNRESET guard already present"
    else
        printf '%s' "${EXISTING_NODE_OPTIONS:+$EXISTING_NODE_OPTIONS }--require=$GUARD_PATH" > /run/s6/container_environment/NODE_OPTIONS
        echo "[Kortix] NODE_OPTIONS ECONNRESET guard enabled"
    fi
fi

# ── Tool dependencies ─────────────────────────────────────────────────────────
# OpenCode bundler resolves modules from /workspace/.cache/opencode (its runtime
# package cache). Pre-seed tool deps there so external tool imports work offline.
CACHE_DIR="${KORTIX_OPENCODE_CACHE_DIR:-/persistent/opencode-cache}"
if [ -d /ephemeral/kortix-master/node_modules ] && [ ! -d "$CACHE_DIR/node_modules/@mendable" ]; then
    mkdir -p "$CACHE_DIR"
    cp -r /ephemeral/kortix-master/node_modules "$CACHE_DIR/" 2>/dev/null || true
    # Copy package.json so bun treats it as a valid project
    [ -f /ephemeral/kortix-master/opencode/package.json ] && cp /ephemeral/kortix-master/opencode/package.json "$CACHE_DIR/" 2>/dev/null || true
    chown -R abc:users "$CACHE_DIR" 2>/dev/null || true
    echo "[Kortix] Tool deps seeded into $CACHE_DIR"
fi

echo "[Kortix] Environment setup complete"

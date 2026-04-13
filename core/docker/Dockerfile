# syntax=docker/dockerfile:1.7
#
# kortix/computer — sandbox image
#
# ONE image. Everything baked at build time. No OTA, no npm, no symlinks.
# Updates = pull new image + recreate container.
#
# ┌─────────────────────────────────────────────────────────────────────────┐
# │                      PERSISTENCE CONTRACT                              │
# │                                                                        │
# │  /workspace/   = PERSISTENT  (Docker volume, survives everything)      │
# │  /opt/         = AVAILABLE   (user/system, container layer)            │
# │  /ephemeral/   = SHIPPED     (Kortix runtime, REPLACED on update)     │
# │  /run/s6/      = TMPFS       (rebuilt from /workspace on boot)         │
# │                                                                        │
# │  Rule: ALL user state MUST live under /workspace/.                     │
# │  Rule: NEVER store runtime state in /ephemeral/. It gets replaced.     │
# │  Rule: /run/s6/container_environment/ is rebuilt from encrypted        │
# │        secrets at boot via 97-secrets-to-s6-env.sh.                    │
# └─────────────────────────────────────────────────────────────────────────┘
#
# Container layout:
#   PERSISTENT (/workspace/ volume):
#     .secrets/                    Encrypted secrets, salt, encryption key
#     .local/share/opencode/       OpenCode state (sessions, SQLite DBs)
#     .local/bin/, .local/lib/     User pip packages
#     .npm-global/                 User npm -g packages
#     .opencode/                   OpenCode config (skills, agents from marketplace)
#     .kortix/                     Kortix state, package manifests
#     .lss/                        LSS search index
#     .browser-profile/            Chromium profile
#     .cache/opencode/             OpenCode runtime cache
#     .git/                        Workspace git repo
#     *                            User code, projects, files
#
#   EPHEMERAL (/ephemeral/ — shipped runtime, replaced on update):
#     /ephemeral/kortix-master/    Hono server, OpenCode config, channels, triggers
#     /ephemeral/metadata/         Version metadata, service spec, changelog
#     /ephemeral/agent-browser-viewer/ Browser viewer HTML
#     /ephemeral/services/         Service scripts
#     /ephemeral/startup.sh        Container entrypoint
#
#   THIRD-PARTY (/opt/ — baked at build, not user-modifiable):
#     /opt/bun/                    Bun runtime
#     /opt/bun-pty-musl/           PTY native library
#

# ── Stage 1: Build musl-compatible bun-pty Rust library ─────────────────────
FROM rust:alpine AS rust-pty-builder
RUN --mount=type=cache,target=/var/cache/apk \
    apk add --no-cache musl-dev gcc git
RUN git clone --depth 1 https://github.com/sursaone/bun-pty.git /build/bun-pty
WORKDIR /build/bun-pty/rust-pty
RUN sed -i 's/crate-type = \["cdylib"\]/crate-type = ["staticlib"]/' Cargo.toml
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/usr/local/cargo/git,sharing=locked \
    cargo build --release
RUN gcc -shared -o /build/librust_pty.so \
    -Wl,--whole-archive target/release/librust_pty.a -Wl,--no-whole-archive \
    -lpthread -ldl -lutil -lm

# ── Stage 2: Main image ─────────────────────────────────────────────────────
FROM lscr.io/linuxserver/webtop:latest

ARG SANDBOX_VERSION=0.0.0-dev

# Global binary versions — pinned here, bumped manually
ARG OPENCODE_VERSION=1.2.25
ARG AGENT_BROWSER_VERSION=0.19.0
ARG OCX_VERSION=2.0.0

# ── License ──────────────────────────────────────────────────────────────────
COPY LICENSE /LICENSE

# ── Skill/runtime requirement inventory ──────────────────────────────────────
# The skill tree under core/kortix-master/opencode/skills/ currently references
# or strongly implies the following baked-in runtime surface:
#   - Baseline CLIs: bash, bun, curl, git, gh, jq, docker cli, ripgrep,
#     rsync, ssh, unzip, uv, node/npm, python3/pip
#   - Document/PDF stack: pandoc, soffice/libreoffice, poppler (pdftotext,
#     pdftoppm, pdfimages), qpdf, tesseract, imagemagick, texlive/bibtex
#   - Media/browser stack: ffmpeg/ffprobe, chromium, Playwright runtimes
#   - Research/utilities: whois (domain-research), git/gh (coding-and-data)
#   - Font coverage: fontconfig + Latin/CJK/emoji families for PDF/browser
#     rendering consistency across PDF/docx/pptx/website skills
#   - Python libs: pypdf, pdfplumber, reportlab, pypdfium2, PyPDF2,
#     pdf2image, pytesseract, PyMuPDF, openpyxl, python-pptx, lxml, Pillow,
#     pdf2docx, docx2pdf, python-docx, markitdown[pptx], numpy, pandas,
#     matplotlib, seaborn, playwright, youtube-transcript-api, rembg,
#     onnxruntime, fastapi[standard]
#   - Node globals used directly by skills/tests: pptxgenjs, docx, pdf-lib,
#     playwright, react, react-dom, react-icons, sharp, appium
#   - Host-only deps intentionally NOT baked here: Xcode/iOS simulator stack,
#     agent-click on the user's macOS machine via Agent Tunnel
#
# Keep this inventory close to the install blocks so Dockerfile/package drift is
# easy to audit when skills add new runtime assumptions.

# ── OS packages ──────────────────────────────────────────────────────────────
RUN apk update \
    && apk add --no-cache \
        nodejs npm rsync \
        python3-dev py3-pip py3-virtualenv \
        curl unzip ca-certificates \
        gcc g++ musl-dev linux-headers \
        libffi-dev libxml2-dev libxslt-dev \
        gcompat \
        git github-cli jq ripgrep \
        docker docker-cli-compose \
        fuse-overlayfs iptables ip6tables \
        whois \
        fontconfig ttf-dejavu font-liberation font-noto font-noto-cjk font-noto-emoji \
        openssh-server openssh-sftp-server \
        bash-completion \
    && rm -rf /var/cache/apk/*

# ── Skill system dependencies ────────────────────────────────────────────────
# Tools referenced by skills in opencode/skills/GENERAL-KNOWLEDGE-WORKER/
# and opencode/skills/KORTIX-system/. Installed here so they're baked into
# the image rather than downloaded at runtime.
# poppler-utils: pdftotext, pdftoppm, pdfimages (pdf skill)
# qpdf: PDF merge/split/encrypt/repair (pdf skill)
# pandoc: docx↔md conversion, track-changes (docx skill)
# libreoffice: headless convert, recalc, render (docx/xlsx/pptx skills)
# tesseract-ocr: OCR engine for pytesseract (pdf skill)
# ffmpeg: media processing (remotion, media skills)
# imagemagick: crop/inspect rendered pages during PDF form work
# texlive: pdflatex + bibtex (paper-creator skill)
# *-dev: build deps for Pillow, pdf2image (pptx, pdf, logo-creator)
RUN apk update \
    && apk add --no-cache \
        poppler-utils poppler-dev \
        qpdf \
        pandoc \
        libreoffice \
        tesseract-ocr tesseract-ocr-data-eng \
        ffmpeg \
        imagemagick \
        texlive texmf-dist-latexrecommended texmf-dist-bibtexextra \
        jpeg-dev zlib-dev freetype-dev openjpeg-dev tiff-dev \
    && rm -rf /var/cache/apk/*

# ── Bun runtime ───────────────────────────────────────────────────────────────
ENV BUN_INSTALL=/opt/bun
RUN for i in 1 2 3; do curl -fsSL https://bun.sh/install | bash && break || sleep 5; done \
    && test -x /opt/bun/bin/bun \
    && ln -sf /opt/bun/bin/bun /usr/local/bin/bun
RUN mkdir -p /opt/bun/install/cache && chown -R abc:abc /opt/bun

# ── uv (Python package runner) ───────────────────────────────────────────────
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh

# ── lss — Local Semantic Search CLI ──────────────────────────────────────────
# Provides `lss` (search) and `lss-sync` (file watcher) commands.
# Explicitly use the base image's virtualenv pip to ensure binaries land in
# /lsiopy/bin/ (which is in PATH) and not in some user-local dir.
ARG LSS_VERSION=0.5.5
RUN /lsiopy/bin/pip install --no-cache-dir "local-semantic-search==${LSS_VERSION}" \
    && test -x /lsiopy/bin/lss \
    && /lsiopy/bin/lss --version

# ── Skill Python packages ────────────────────────────────────────────────────
# All pip packages referenced by skill scripts and SKILL.md documentation.
# Installed into /lsiopy/ (base image virtualenv, in PATH) so they're
# available to all Python invocations without user-install at runtime.
#
# Group 1: Document processing (pdf, docx, pptx, xlsx skills)
# Group 2: Data science / visualization (visualization, xlsx skills)
# Group 3: Media / AI (logo-creator, presentations, media skills)
# Group 4: App/server tooling (fastapi-sdk skill)
# PDF: pypdf pdfplumber reportlab pypdfium2 PyPDF2 pdf2image pytesseract PyMuPDF
# Office: openpyxl python-pptx lxml Pillow pdf2docx docx2pdf markitdown[pptx]
# Data science: numpy pandas matplotlib seaborn
# Presentations/logo: playwright (uses system chromium via PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)
# YouTube: youtube-transcript-api
RUN /lsiopy/bin/pip install --no-cache-dir \
    pypdf pdfplumber reportlab pypdfium2 PyPDF2 pdf2image pytesseract \
    openpyxl python-pptx python-docx lxml Pillow pdf2docx docx2pdf "markitdown[pptx]" \
    numpy pandas matplotlib seaborn \
    playwright youtube-transcript-api "fastapi[standard]" \
    && echo "[docker] Skill Python packages installed." \
    && /lsiopy/bin/pip install --no-cache-dir PyMuPDF 2>/dev/null \
    && echo "[docker] PyMuPDF installed." \
    || echo "[docker] WARN: PyMuPDF skipped (build fails on musl/aarch64). PDF skills use pypdf/pdfplumber instead."

# Optional heavy packages — rembg + onnxruntime for logo background removal.
# These may fail on Alpine musl; the skill falls back to Replicate API.
RUN /lsiopy/bin/pip install --no-cache-dir rembg onnxruntime 2>/dev/null \
    && echo "[docker] rembg + onnxruntime installed." \
    || echo "[docker] WARN: rembg/onnxruntime skipped (musl-incompatible). Logo bg removal will use Replicate API."

# ── Skill npm global packages ────────────────────────────────────────────────
# Node packages used by pptx (deck creation), docx/pdf (document creation),
# browser E2E checks, and the pptx icon rendering pipeline.
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install -g --no-audit --no-fund \
    pptxgenjs \
    docx \
    pdf-lib \
    playwright \
    appium \
    react react-dom react-icons \
    sharp \
    && echo "[docker] Skill npm packages installed."

# ── bun-pty musl .so ──────────────────────────────────────────────────────────
COPY --from=rust-pty-builder /build/librust_pty.so /opt/bun-pty-musl/librust_pty.so
RUN chmod 644 /opt/bun-pty-musl/librust_pty.so
ENV BUN_PTY_LIB=/opt/bun-pty-musl/librust_pty.so

# ── Workspace (PERSISTENT zone — Docker volume) ─────────────────────────────
# Everything in /workspace/ survives container recreate/update.
# The Docker volume is mounted here. This is the ONLY persistent storage.
RUN mkdir -p /workspace/.browser-profile \
    /workspace/.lss /workspace/.cache/opencode /workspace/presentations \
    /workspace/.local/share/opencode /workspace/.local/share/opencode/log \
    /workspace/.local/share/opencode/storage /workspace/.local/share/opencode/snapshot \
    /workspace/.XDG /workspace/.config \
    /workspace/.kortix \
    /workspace/.secrets \
    /workspace/.opencode /workspace/.opencode/skills \
    /workspace/.local/bin \
    /workspace/.npm-global/bin \
    /workspace/.npm-global/lib \
    && chmod 700 /workspace/.secrets \
    # Bake .gitignore so these dirs are always excluded from git snapshots.
    # kortix-env-setup.sh commits this in the initial workspace commit.
    && printf '%s\n' \
        '# kortix/opencode internal dirs — excluded from agent snapshots' \
        '.local/share/opencode/' \
        '.cache/' \
        '.config/' \
        '.opencode/' \
        '.kortix/' \
        '.kortix-state/' \
        '.secrets/' \
        '.browser-profile/' \
        '.agent-browser/' \
        '.lss/' \
        '.ocx/' \
        '.XDG/' \
        '.bun/' \
        '.npm-global/' \
        '.npm/' \
        '.dbus/' \
        '.pki/' \
        '.ssh/' \
        'ssl/' \
        'opencode' \
        > /workspace/.gitignore \
    && chown -R abc:abc /workspace \
    && rm -rf /config \
    && ln -s /workspace /config \
    && git config --system --add safe.directory '*' \
    && echo "abc ALL=(root) NOPASSWD: /usr/bin/s6-svc, /bin/s6-svc, /usr/sbin/s6-svc, /usr/bin/s6-rc, /bin/s6-rc" >> /etc/sudoers
WORKDIR /workspace
ENV KORTIX_WORKSPACE=/workspace

# NOTE: Persistent package ENVs (PYTHONUSERBASE, PIP_USER, NPM_CONFIG_PREFIX)
# are set AFTER the build step — see "Runtime persistence" section below.
# Setting them here would redirect build-time `npm install -g` into /workspace/
# which gets overlaid by the Docker volume at runtime, losing the binaries.

# ── Services (s6-rc.d longrun) ──────────────────────────────────────────────
COPY core/s6-services/ /etc/s6-overlay/s6-rc.d/
RUN for svc in svc-kortix-master svc-opencode-serve svc-opencode-state-sync \
        svc-chromium-persistent svc-agent-browser-session svc-agent-browser-viewer \
        svc-static-web svc-lss-sync svc-sshd svc-docker; do \
        touch "/etc/s6-overlay/s6-rc.d/user/contents.d/${svc}"; \
    done \
    && chmod +x /etc/s6-overlay/s6-rc.d/svc-*/run \
    && chmod +x /etc/s6-overlay/s6-rc.d/svc-*/finish 2>/dev/null || true

# ── Service scripts (baked-in JS — no more /tmp/ temp files) ────────────────
COPY core/services/ /ephemeral/services/

# Silence spammy base-image desktop finish script
RUN printf '#!/bin/bash\nPID_FILE="/de-pid"\nif [ ! -r "$PID_FILE" ]; then exit 0; fi\nPARENT_PID=$(cat "$PID_FILE")\nif [ -z "$PARENT_PID" ]; then rm -f "$PID_FILE"; exit 0; fi\nPIDS=$(pstree -p "$PARENT_PID" 2>/dev/null | grep -o "([0-9]\\+)" | grep -o "[0-9]\\+" | grep -v "^${PARENT_PID}$")\n[ -n "$PIDS" ] && echo "$PIDS" | xargs kill -TERM -- 2>/dev/null && sleep 1\nrm -f "$PID_FILE"\nexit 0\n' > /etc/s6-overlay/s6-rc.d/svc-de/finish \
    && chmod +x /etc/s6-overlay/s6-rc.d/svc-de/finish

# ── Container init scripts ───────────────────────────────────────────────────
RUN mkdir -p /custom-cont-init.d
COPY core/init-scripts/95-setup-sshd.sh /custom-cont-init.d/95-setup-sshd
COPY core/init-scripts/96-fix-bun-pty.sh /custom-cont-init.d/96-fix-bun-pty
COPY core/init-scripts/97-secrets-to-s6-env.sh /custom-cont-init.d/97-secrets-to-s6-env
COPY core/init-scripts/kortix-env-setup.sh /custom-cont-init.d/98-kortix-env
COPY core/init-scripts/99-restore-packages.sh /custom-cont-init.d/99-restore-packages
COPY core/init-scripts/99-fix-opencode-ownership.sh /custom-cont-init.d/zz-fix-opencode-ownership
RUN chmod +x /custom-cont-init.d/*

# ── Persistent package wrapper (apk-persist) ────────────────────────────────
COPY core/scripts/apk-persist /usr/local/bin/apk-persist
RUN chmod +x /usr/local/bin/apk-persist

COPY core/scripts/kortix-opencode-state /usr/local/bin/kortix-opencode-state
RUN chmod +x /usr/local/bin/kortix-opencode-state

# ── Docker-in-Docker readiness helper ───────────────────────────────────────
# Polls `docker info` until dockerd is reachable. Use from anywhere that
# needs to run `docker ...` commands early in the boot sequence.
COPY core/scripts/docker-wait-ready /usr/local/bin/docker-wait-ready
RUN chmod +x /usr/local/bin/docker-wait-ready

# ── Pre-create /var/lib/docker so the named volume mounts cleanly ───────────
# dockerd uses this as its data-root. Compose mounts a named volume here so
# the storage lives on the host's native filesystem (required for overlay2).
RUN mkdir -p /var/lib/docker /etc/docker

# ── E2E test scripts ────────────────────────────────────────────────────────
COPY core/tests/ /ephemeral/tests/
RUN chmod +x /ephemeral/tests/*.sh 2>/dev/null || true

# ── Copy source packages to build staging area ──────────────────────────────
# All sandbox packages are now consolidated inside core/kortix-master/
#   kortix-master/opencode/   — OpenCode config dir (agents, skills, plugins, tools)
#   kortix-master/channels/   — CLIs: ktelegram, kslack, kchannel, kconnectors, kpipedream
#   kortix-master/triggers/   — Cron + webhook triggers
COPY core/kortix-master  /opt/build/kortix-master
COPY core/s6-services/svc-agent-browser-viewer/index.html /opt/build/browser-viewer/index.html

# ── Build sandbox runtime ────────────────────────────────────────────────────
RUN set -eo pipefail && echo "[docker] Building sandbox runtime v${SANDBOX_VERSION}..." && \
    \
    # ── 1. kortix-master (single bun install — includes triggers, channels, opencode deps) ── \
    mkdir -p /ephemeral/kortix-master && \
    rsync -a --exclude=node_modules --exclude=bun.lock --exclude=.git \
      /opt/build/kortix-master/ /ephemeral/kortix-master/ && \
    cd /ephemeral/kortix-master && bun install 2>&1 && \
    test -d /ephemeral/kortix-master/node_modules && \
    chmod +x /ephemeral/kortix-master/scripts/*.sh 2>/dev/null || true && \
    echo "[docker] kortix-master: bun install OK (includes triggers, channel CLIs, opencode)" && \
    \
    # ── 1b. Install Kortix CLI wrappers into /usr/local/bin ── \
    /ephemeral/kortix-master/scripts/install-channel-clis.sh && \
    \
    # ── 2. skills shipped in-tree under skills/KORTIX-system/ (recursive discovery) ── \
    echo "[docker] skills: agent-tunnel, agent-browser, presentations in /ephemeral/kortix-master/opencode/skills/KORTIX-system/" && \
    \
    # ── 4. bun-pty musl patches ── \
    ARCH=$(uname -m) && \
    for PTY_DIR in \
        /ephemeral/kortix-master/node_modules/bun-pty/rust-pty/target/release \
        /opt/bun/install/cache/bun-pty@*/rust-pty/target/release; do \
      [ -d "$PTY_DIR" ] || continue; \
      if [ "$ARCH" = "x86_64" ]; then \
        cp /opt/bun-pty-musl/librust_pty.so "$PTY_DIR/librust_pty.so"; \
      else \
        cp /opt/bun-pty-musl/librust_pty.so "$PTY_DIR/librust_pty_arm64.so"; \
      fi; \
    done && \
    \
    # ── 6. Agent browser viewer ── \
    mkdir -p /ephemeral/agent-browser-viewer && \
    rsync -a --delete /opt/build/browser-viewer/ /ephemeral/agent-browser-viewer/ && \
    \
    # ── 7. Version metadata ── \
    mkdir -p /ephemeral/metadata && \
    printf '{"version":"%s","updatedAt":"%s"}\n' "${SANDBOX_VERSION}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > /ephemeral/metadata/.version && \
    \
    # ── 8. Global CLI binaries (direct install, no intermediate package.json) ── \
    npm install -g --no-audit --no-fund \
      "opencode-ai@${OPENCODE_VERSION}" \
      "agent-browser@${AGENT_BROWSER_VERSION}" \
      "ocx@${OCX_VERSION}" 2>&1 && \

    # opencode postinstall caches a non-musl binary at .opencode — remove it \
    # so the launcher resolves the musl variant (Alpine is musl-based) \
    rm -f /usr/local/lib/node_modules/opencode-ai/bin/.opencode 2>/dev/null || true && \
    command -v opencode >/dev/null && \
    command -v agent-browser >/dev/null && \
    command -v ocx >/dev/null && \
    echo "[docker] Global binaries: opencode=$(opencode --version 2>/dev/null || echo '?'), agent-browser, ocx" && \
    \
    # ── 9. Binary patches (MUST run after npm install -g opencode-ai) ── \
    bash /ephemeral/kortix-master/opencode/patches/apply.sh && \
    \
    # ── 10. Fix agent-browser native binary on Alpine musl ── \
    # The Rust native binary requires glibc's __res_init which doesn't exist in musl. \
    # Compile a tiny stub .so and create a wrapper that LD_PRELOADs it. \
    printf 'int __res_init(void){return 0;}\n' > /tmp/res_init_stub.c && \
    gcc -shared -o /usr/local/lib/libres_init.so /tmp/res_init_stub.c && \
    rm -f /tmp/res_init_stub.c && \
    # Create wrapper that sets LD_PRELOAD before calling the real binary \
    mv /usr/local/bin/agent-browser /usr/local/bin/agent-browser-real && \
    printf '#!/bin/sh\nexport LD_PRELOAD=/usr/local/lib/libres_init.so\nexec /usr/local/bin/agent-browser-real "$@"\n' > /usr/local/bin/agent-browser && \
    chmod +x /usr/local/bin/agent-browser && \
    echo "[docker] agent-browser musl shim installed" && \
    \
    # ── 10. Fix ownership ── \
    # CRITICAL: Use abc:abc (UID 911) — NOT 1000:1000. The linuxserver base image \
    # creates user abc with UID 911. All runtime processes (opencode, kortix-master) \
    # run as abc via s6-setuidgid. Using 1000 causes EACCES everywhere at runtime. \
    chown -R abc:abc /ephemeral \
      2>/dev/null || true && \
    \
    # ── 11. Cleanup ── \
    rm -rf /opt/build /root/.npm/_cacache /root/.npm/_logs 2>/dev/null || true && \
    echo "[docker] Build complete."

# ── Startup entrypoint ────────────────────────────────────────────────────────
COPY core/startup.sh /ephemeral/startup.sh
RUN chmod +x /ephemeral/startup.sh

# ── Runtime persistence — user-installed packages survive restarts ────────────
# These ENVs are set AFTER the build step intentionally. During build, npm/pip
# use system paths (/usr/local/) so core tools are baked into the image layer.
# At runtime, these redirect user installs to /workspace/ (the persistent volume).
#
# pip:    PYTHONUSERBASE + PIP_USER=1  → /workspace/.local/
# npm -g: NPM_CONFIG_PREFIX           → /workspace/.npm-global/
# apk:   apk-persist wrapper          → manifest in /workspace/.kortix/packages/
#
ENV PYTHONUSERBASE=/workspace/.local
ENV PIP_USER=1
ENV NPM_CONFIG_PREFIX=/workspace/.npm-global
ENV NODE_PATH="/usr/local/lib/node_modules:${NODE_PATH}"
ENV PATH="/workspace/.npm-global/bin:/workspace/.local/bin:${PATH}"

# ── Environment ───────────────────────────────────────────────────────────────
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium-browser
ENV AGENT_BROWSER_SESSION=kortix
ENV AGENT_BROWSER_PRIMARY_SESSION=kortix
ENV AGENT_BROWSER_HEADED=1
ENV AGENT_BROWSER_SOCKET_DIR=/dev/shm/agent-browser
ENV AGENT_BROWSER_ARGS="--no-sandbox,--disable-gpu,--disable-dev-shm-usage,--disable-infobars,--disable-blink-features=AutomationControlled,--disable-features=VizDisplayCompositor"
ENV AGENT_BROWSER_USER_AGENT="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
ENV AGENT_BROWSER_IDLE_TIMEOUT_MS=0
ENV AGENT_BROWSER_STREAM_PORT=9223
ENV OPENCODE_CONFIG_DIR=/ephemeral/kortix-master/opencode
ENV KORTIX_PERSISTENT_ROOT=/persistent
ENV OPENCODE_STORAGE_BASE=/persistent/opencode
ENV OPENCODE_SHADOW_STORAGE_BASE=/persistent/opencode-shadow
ENV KORTIX_OPENCODE_ARCHIVE_DIR=/persistent/opencode-archive
ENV KORTIX_OPENCODE_CACHE_DIR=/persistent/opencode-cache
ENV AUTH_JSON_PATH=/persistent/opencode/auth.json
ENV SECRET_FILE_PATH=/persistent/secrets/.secrets.json
ENV SALT_FILE_PATH=/persistent/secrets/.salt
ENV ENCRYPTION_KEY_PATH=/persistent/secrets/.encryption-key
ENV LSS_DIR=/persistent/lss
ENV SANDBOX_VERSION=${SANDBOX_VERSION}

# ── Docker-in-Docker defaults ────────────────────────────────────────────────
# DOCKER_HOST is the unix socket dockerd creates inside this container. Set
# it globally so every shell and every `docker` invocation inside the sandbox
# hits the DinD daemon, not the host socket (which isn't mounted anyway).
ENV DOCKER_HOST=unix:///var/run/docker.sock

# ── Playwright — use system Chromium (no separate download needed) ───────────
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# ── Desktop config — Selkies streaming ───────────────────────────────────────
# Ports
ENV CUSTOM_PORT=6080
ENV CUSTOM_HTTPS_PORT=6081
ENV TITLE="Kortix Computer"
# Resolution: auto-adapt to iframe/browser size (no manual lock)
# Display: standard 100% UI scaling (96 DPI)
# Encoder: x264enc locked, 60 FPS locked, CRF 18 (near-lossless), full 4:4:4 color
ENV SELKIES_ENCODER="x264enc"
ENV SELKIES_FRAMERATE="60"
ENV SELKIES_H264_CRF="18"
ENV SELKIES_H264_FULLCOLOR=true
ENV SELKIES_USE_CSS_SCALING=false
# UI scaling: 100% DPI (standard)
ENV SELKIES_SCALING_DPI="96"
# Paint-overs: high quality for static scenes (sharp text/UI)
ENV SELKIES_USE_PAINT_OVER_QUALITY=true
ENV SELKIES_PAINT_OVER_JPEG_QUALITY="90"
ENV SELKIES_H264_PAINTOVER_CRF="12"
# Cursors: CSS cursors for lower latency
ENV SELKIES_USE_BROWSER_CURSORS=true


EXPOSE 22 3456 6080 6081 3210 8000 9222 9223 9224

ENTRYPOINT ["/ephemeral/startup.sh"]

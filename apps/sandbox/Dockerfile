# syntax=docker/dockerfile:1.7
#
# Kortix sandbox image — the base Daytona snapshot for every project
# session. Bakes:
#   - git + ca-certificates + curl  (project repo materialization)
#   - ripgrep                       (daemon /find text search; Node fallback
#                                    covers images built before this was added)
#   - Python + common document/data packages used by starter skills
#   - opencode CLI                  (the supervised child process)
#   - kortix-agent                  (compiled daemon from
#                                    apps/kortix-sandbox-agent-server)
#   - kortix                        (compiled admin CLI from apps/cli — the
#                                    in-sandbox `kortix cr open`, `secrets`,
#                                    `sessions`, … surface every agent uses)
#
# Three-stage build:
#   1. `builder`     — installs the daemon's deps and runs
#                      `bun build --compile` for the target image architecture
#                      to produce /agent/dist/kortix-agent.
#   2. `cli-builder` — assembles a minimal workspace (apps/cli + the two
#                      `@kortix/*` packages it imports) and compiles the
#                      `kortix` CLI to a self-contained /cli/kortix binary.
#   3. final         — copies both binaries onto a clean runtime base
#                      alongside git + opencode.
#
# Build from the repo root:
#   docker build -f apps/sandbox/Dockerfile -t kortix/kortix-sandbox:dev .
#
# To register with Daytona, push to a registry then point the snapshot
# at the resulting image:tag.

# ─── Stage 1: build the agent binary ────────────────────────────────────

FROM oven/bun:1-debian AS builder

ARG TARGETARCH

WORKDIR /agent
COPY apps/kortix-sandbox-agent-server/package.json apps/kortix-sandbox-agent-server/bun.lock ./
RUN bun install --frozen-lockfile
COPY apps/kortix-sandbox-agent-server/ ./
RUN case "${TARGETARCH:-}" in \
        amd64) export BUN_COMPILE_TARGET=bun-linux-x64 ;; \
        arm64) export BUN_COMPILE_TARGET=bun-linux-arm64 ;; \
        *) echo "Unsupported Docker target architecture: ${TARGETARCH:-unknown}" >&2; exit 1 ;; \
    esac \
    && bash scripts/build.sh

# ─── Stage 2: build the kortix CLI binary ───────────────────────────────
#
# The CLI lives in apps/cli and imports four workspace packages
# (@kortix/executor-sdk, @kortix/manifest-schema, @kortix/registry,
# @kortix/starter) plus one npm dep (smol-toml).
# `bun build --compile` inlines all of them, so the runtime image carries a
# single self-contained binary and never needs node_modules on PATH — the
# same shape as kortix-agent. We assemble a throwaway workspace root so bun
# can resolve the `@kortix/*` names to their source, then compile.

FROM oven/bun:1-debian AS cli-builder

ARG TARGETARCH

WORKDIR /cli
COPY apps/cli ./apps/cli
COPY packages/executor-sdk ./packages/executor-sdk
COPY packages/manifest-schema ./packages/manifest-schema
COPY packages/registry ./packages/registry
COPY packages/starter ./packages/starter
RUN printf '{"name":"kortix-cli-build","private":true,"workspaces":["apps/cli","packages/*"]}\n' > package.json \
    && case "${TARGETARCH:-}" in \
        amd64) export BUN_COMPILE_TARGET=bun-linux-x64 ;; \
        arm64) export BUN_COMPILE_TARGET=bun-linux-arm64 ;; \
        *) export BUN_COMPILE_TARGET=bun-linux-x64 ;; \
    esac \
    && bun install --no-save \
    && BUN_COMPILE_TARGET="$BUN_COMPILE_TARGET" bash apps/cli/scripts/build.sh \
    && cp apps/cli/dist/kortix /cli/kortix

# ─── Stage 3: runtime ───────────────────────────────────────────────────

FROM oven/bun:1-debian

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        build-essential \
        ffmpeg \
        fonts-dejavu \
        fonts-liberation \
        fonts-noto \
        fonts-noto-cjk \
        git \
        latexmk \
        libreoffice \
        nodejs \
        npm \
        pandoc \
        pkg-config \
        poppler-utils \
        python3 \
        python3-dev \
        python3-pip \
        python3-venv \
        qpdf \
        ripgrep \
        texlive-bibtex-extra \
        texlive-fonts-recommended \
        texlive-latex-base \
        texlive-latex-extra \
        texlive-latex-recommended \
        tesseract-ocr \
        unzip \
    && rm -rf /var/lib/apt/lists/*

# Python libraries referenced by the starter marketplace skills. Ubuntu marks
# system Python as externally managed, so use --break-system-packages
# intentionally: these packages are part of the immutable sandbox image, not a
# user-managed workstation install.
RUN python3 -m pip install --break-system-packages --no-cache-dir \
        "beautifulsoup4>=4.12" \
        "lxml>=5" \
        "markdownify>=0.13" \
        "markitdown[pptx]>=0.1.0" \
        "matplotlib>=3.8" \
        "numpy>=1.26" \
        "openpyxl>=3.1" \
        "pandas>=2.2" \
        "pdf2docx>=0.5" \
        "pdf2image>=1.17" \
        "pdfplumber>=0.11" \
        "pillow>=10" \
        "playwright>=1.58" \
        "plotly>=5.22" \
        "pymupdf>=1.24" \
        "pypdf>=4" \
        "pypdfium2>=4.30" \
        "pytesseract>=0.3" \
        "python-docx>=1.1" \
        "python-pptx>=1.0" \
        "reportlab>=4.2" \
        "requests>=2.32" \
        "scikit-learn>=1.4" \
        "scipy>=1.12" \
        "seaborn>=0.13" \
        "youtube-transcript-api>=0.6" \
    && python3 - <<'PY'
import importlib
mods = [
  "bs4", "lxml", "markitdown", "matplotlib", "numpy", "openpyxl",
  "pandas", "pdf2docx", "pdf2image", "pdfplumber", "PIL", "playwright",
  "plotly", "fitz", "pypdf", "pypdfium2", "pytesseract", "docx", "pptx",
  "reportlab", "requests", "sklearn", "scipy", "seaborn",
  "youtube_transcript_api",
]
for mod in mods:
    importlib.import_module(mod)
print("starter Python package floor OK")
PY

# OpenCode is distributed as an npm package. Install globally so it ends
# up on PATH as `opencode` — the daemon will auto-detect it (or prefer
# /usr/local/bin/opencode-kortix if a patched build is present).
COPY packages/shared/src/runtime-versions.json /tmp/kortix-runtime-versions.json
RUN OPENCODE_VERSION="$(node -e "console.log(require('/tmp/kortix-runtime-versions.json').opencode)")" \
    && npm install -g --no-audit --no-fund "opencode-ai@${OPENCODE_VERSION}" \
    && command -v opencode \
    && opencode --version

# Pre-warm Bun's package cache with the OpenCode tool dependencies. The tools in
# .kortix/opencode/tools/ (web_search, image_search, scrape_webpage) import these,
# and OpenCode runs `bun install` in the cloned config dir at boot. Warming the
# cache at the runtime HOME path (HOME=/opt/kortix/home) makes that boot-time
# install offline + fast — no per-boot download.
# Keep in sync with packages/starter/templates/base/.kortix/opencode/package.json.
RUN mkdir -p /opt/kortix/home/.bun/install/cache /tmp/oc-deps \
    && cd /tmp/oc-deps \
    && printf '{"dependencies":{"@mendable/firecrawl-js":"^4.25.1","@tavily/core":"^0.7.3","replicate":"^1.4.0"}}' > package.json \
    && BUN_INSTALL_CACHE_DIR=/opt/kortix/home/.bun/install/cache bun install \
    && rm -rf /tmp/oc-deps

# agent-browser (Vercel agent-browser): browser-automation CLI for the agent.
# Chrome for Testing (what `agent-browser install` fetches) has no linux-arm64
# build, so we source Chromium from Playwright instead — it ships both
# linux-x64 and linux-arm64 builds and installs the OS libs via --with-deps.
# We wire agent-browser to it TWO independent ways so it works out of the box
# with no runtime download: (1) AGENT_BROWSER_EXECUTABLE_PATH → a stable
# /usr/local/bin/chromium symlink, and (2) a symlink into agent-browser's OWN
# browser cache (chrome-linux64) that its auto-detect finds even if the env var
# is ever ignored again (vercel-labs/agent-browser#422). The build FAILS LOUDLY
# if Chromium didn't wire up. HOME pins the cache to the runtime HOME so the
# agent finds it at runtime. Keep PLAYWRIGHT_VERSION in sync with
# packages/shared/src/runtime-versions.json.
# --no-sandbox: container runs as root and Chromium refuses its own sandbox there.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers \
    AGENT_BROWSER_EXECUTABLE_PATH=/usr/local/bin/chromium \
    AGENT_BROWSER_ARGS=--no-sandbox,--disable-dev-shm-usage
RUN AGENT_BROWSER_VERSION="$(node -e "console.log(require('/tmp/kortix-runtime-versions.json').agentBrowser)")" \
    && PLAYWRIGHT_VERSION="$(node -e "console.log(require('/tmp/kortix-runtime-versions.json').playwright)")" \
    && npm install -g --no-audit --no-fund "agent-browser@${AGENT_BROWSER_VERSION}" \
    && agent-browser --version \
    && HOME=/opt/kortix/home npx -y playwright@${PLAYWRIGHT_VERSION} install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/* \
    && pw_chrome="$(find /opt/pw-browsers -type f -path '*chrome-linux*/chrome' | head -n1)" \
    && test -n "$pw_chrome" \
    && ln -sf "$pw_chrome" /usr/local/bin/chromium \
    && mkdir -p /opt/kortix/home/.agent-browser/browsers \
    && ln -sf "$(dirname "$pw_chrome")" /opt/kortix/home/.agent-browser/browsers/chrome-linux64 \
    && /usr/local/bin/chromium --version \
    # Match the resolved PATH, not the browser name ("Chromium" on arm64 vs
    # "Google Chrome for Testing" on x64). Reads the detection line, not the
    # launch verdict, so it's safe under cross-arch QEMU builds.
    && env -u AGENT_BROWSER_EXECUTABLE_PATH HOME=/opt/kortix/home agent-browser doctor 2>&1 | grep -qE 'pass.+chrome-linux64/chrome'

COPY --from=builder /agent/dist/kortix-agent /usr/local/bin/kortix-agent
# The admin CLI every in-sandbox agent reaches for: `kortix cr open`,
# `kortix secrets`, `kortix sessions`, … Pre-authenticated at runtime via the
# project-scoped token the platform injects (KORTIX_CLI_TOKEN).
COPY --from=cli-builder /cli/kortix /usr/local/bin/kortix
COPY apps/sandbox/entrypoint.sh /usr/local/bin/kortix-entrypoint
# Keep the repo-relative layout under /opt/kortix so agent CLIs can import
# shared workspace packages the same way they do in local tests.
COPY apps/sandbox/slack-cli/ /opt/kortix/apps/sandbox/slack-cli/
COPY packages/executor-sdk/ /opt/kortix/packages/executor-sdk/
RUN chmod +x /usr/local/bin/kortix-agent /usr/local/bin/kortix /usr/local/bin/kortix-entrypoint /opt/kortix/apps/sandbox/slack-cli/install-shims.sh \
    && bash /opt/kortix/apps/sandbox/slack-cli/install-shims.sh /opt/kortix/apps/sandbox/slack-cli \
    && kortix --version

# Platform-owned secret delivery. The daemon writes live project secrets to
# /dev/shm/kortix/agent-env.sh (tmpfs — never on the persisted disk); these
# baked hooks source it into every shell — login/non-login, interactive PTY
# shells, and any terminal the user opens — so secrets load automatically and
# CANNOT be removed via user opencode config. (Non-interactive `bash -c` from
# opencode's own tools is covered by BASH_ENV, which the daemon sets when it
# spawns opencode.)
RUN printf '%s\n' '[ -r /dev/shm/kortix/agent-env.sh ] && . /dev/shm/kortix/agent-env.sh' \
      > /etc/profile.d/kortix-agent-env.sh \
    && printf '%s\n' '[ -r /dev/shm/kortix/agent-env.sh ] && . /dev/shm/kortix/agent-env.sh' \
      >> /etc/bash.bashrc

ENV KORTIX_WORKSPACE=/workspace
WORKDIR /workspace

EXPOSE 8000

ENTRYPOINT ["/usr/local/bin/kortix-entrypoint"]

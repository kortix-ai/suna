# syntax=docker/dockerfile:1.7
#
# Kortix sandbox image — the base Daytona snapshot for every project
# session. Bakes:
#   - git + ca-certificates + curl  (project repo materialization)
#   - uv + uv-managed Python       (Python tools resolve dependencies per command)
#   - pnpm + Node.js + npm         (pinned runtime toolchain)
#   - opencode CLI                  (the supervised child process)
#   - Codex CLI + Claude Code       (environment tools invoked by the harness)
#   - kortix-agent                  (compiled daemon from
#                                    apps/kortix-sandbox-agent-server)
#   - kortix                        (compiled admin CLI from apps/cli — the
#                                    in-sandbox `kortix cr open`, `secrets`,
#                                    `sessions`, … surface every agent uses)
#
# Three-stage build:
#   1. `builder`     — installs the daemon's deps and runs
#                      `bun build --compile` for the target image architecture
#                      to produce dist/kortix-agent.
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

FROM oven/bun:1.3.14-debian@sha256:9dba1a1b43ce28c9d7931bfc4eb00feb63b0114720a0277a8f939ae4dfc9db6f AS builder

ARG TARGETARCH

# The daemon builds STANDALONE — its own package.json + bun.lock, no workspace
# root. It does share ONE module with apps/api: the relay wire contract
# (packages/api-contract/src/secret-relay.ts, dependency-free by design and
# asserted so by blocked-headers.test.ts). That is reached through a tsconfig
# `paths` mapping rather than a `"workspace:*"` dependency, because a workspace
# dependency makes `bun install --frozen-lockfile` in this directory fail
# outright ("Workspace dependency ... not found / Searched in ./*") and no
# sandbox image can be built at all. So mirror the repo layout here and copy the
# one package the mapping points at.
WORKDIR /repo/apps/kortix-sandbox-agent-server
COPY apps/kortix-sandbox-agent-server/package.json apps/kortix-sandbox-agent-server/bun.lock ./
RUN bun install --frozen-lockfile
COPY packages/api-contract /repo/packages/api-contract
COPY apps/kortix-sandbox-agent-server/ ./
RUN case "${TARGETARCH:-}" in \
        amd64) export BUN_COMPILE_TARGET=bun-linux-x64 ;; \
        arm64) export BUN_COMPILE_TARGET=bun-linux-arm64 ;; \
        *) echo "Unsupported Docker target architecture: ${TARGETARCH:-unknown}" >&2; exit 1 ;; \
    esac \
    && bash scripts/build.sh

# ─── Stage 2: build the kortix CLI binary ───────────────────────────────
#
# The CLI lives in apps/cli and imports the unified @kortix/sdk plus its other
# workspace packages and npm dependencies.
# `bun build --compile` inlines all of them, so the runtime image carries a
# single self-contained binary and never needs node_modules on PATH — the
# same shape as kortix-agent. We assemble a throwaway workspace root so bun
# can resolve the `@kortix/*` names to their source, then compile.

FROM oven/bun:1.3.14-debian@sha256:9dba1a1b43ce28c9d7931bfc4eb00feb63b0114720a0277a8f939ae4dfc9db6f AS cli-builder

ARG TARGETARCH

WORKDIR /cli
COPY apps/cli ./apps/cli
COPY packages/llm-catalog ./packages/llm-catalog
COPY packages/manifest-schema ./packages/manifest-schema
COPY packages/registry ./packages/registry
COPY packages/sdk ./packages/sdk
COPY packages/shared ./packages/shared
COPY packages/starter ./packages/starter
RUN printf '{"name":"kortix-cli-build","private":true,"workspaces":["apps/cli","packages/*"]}\n' > package.json \
    && case "${TARGETARCH:-}" in \
        amd64) export BUN_COMPILE_TARGET=bun-linux-x64 ;; \
        arm64) export BUN_COMPILE_TARGET=bun-linux-arm64 ;; \
        *) export BUN_COMPILE_TARGET=bun-linux-x64 ;; \
    esac \
    && bun install --no-save \
    && BUN_COMPILE_TARGET="$BUN_COMPILE_TARGET" bash apps/cli/scripts/build.sh \
    && cp apps/cli/dist/kortix /cli/kortix \
    && (cd packages/starter && bun run scripts/write-managed-skills.ts /cli/managed-skills)

# ─── Stage 3: runtime ───────────────────────────────────────────────────

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl git gzip libatomic1 sudo unzip tmux iproute2 iputils-arping util-linux \
        build-essential ffmpeg fonts-dejavu fonts-liberation fonts-noto fonts-noto-cjk \
        latexmk libreoffice pandoc pkg-config poppler-utils qpdf tesseract-ocr \
        texlive-bibtex-extra texlive-fonts-recommended texlive-latex-base \
        texlive-latex-extra texlive-latex-recommended \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --shell /bin/bash --user-group kortix \
    && echo 'kortix ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/kortix \
    && chmod 0440 /etc/sudoers.d/kortix \
    && mkdir -p /workspace /opt/kortix /opt/pw-browsers /ephemeral/kortix-master/opencode \
        /home/kortix/.local/bin /home/kortix/.local/share/pnpm/bin /home/kortix/.bun/bin \
    && chown -R kortix:kortix /workspace /opt/kortix /opt/pw-browsers /ephemeral /home/kortix

ENV PNPM_HOME=/home/kortix/.local/share/pnpm \
    PATH=/home/kortix/.local/bin:/home/kortix/.local/share/pnpm/bin:/home/kortix/.bun/bin:$PATH
USER kortix

COPY packages/shared/src/runtime-versions.json /tmp/kortix-runtime-versions.json
RUN UV_VERSION="$(sed -n 's/.*"uv": "\([^"]*\)".*/\1/p' /tmp/kortix-runtime-versions.json)" \
    && PYTHON_VERSION="$(sed -n 's/.*"python": "\([^"]*\)".*/\1/p' /tmp/kortix-runtime-versions.json)" \
    && UV_SHA256_AMD64="$(sed -n 's/.*"uvSha256Amd64": "\([^"]*\)".*/\1/p' /tmp/kortix-runtime-versions.json)" \
    && UV_SHA256_ARM64="$(sed -n 's/.*"uvSha256Arm64": "\([^"]*\)".*/\1/p' /tmp/kortix-runtime-versions.json)" \
    && test -n "$UV_VERSION" \
    && test -n "$PYTHON_VERSION" \
    && case "$(uname -m)" in \
         x86_64) uv_arch=x86_64; uv_sha="$UV_SHA256_AMD64" ;; \
         aarch64|arm64) uv_arch=aarch64; uv_sha="$UV_SHA256_ARM64" ;; \
         *) echo "unsupported uv architecture: $(uname -m)" >&2; exit 1 ;; \
       esac \
    && curl -fsSL --retry 3 --retry-delay 2 -o /tmp/uv.tar.gz \
         "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${uv_arch}-unknown-linux-gnu.tar.gz" \
    && echo "${uv_sha}  /tmp/uv.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/uv.tar.gz --strip-components=1 -C /home/kortix/.local/bin \
    && rm /tmp/uv.tar.gz \
    && uv --version | grep -Eq "^uv ${UV_VERSION}( |$)" \
    && UV_PYTHON_DOWNLOADS=automatic uv python install --default "$PYTHON_VERSION" \
    && python -c "import sys; assert '.'.join(map(str, sys.version_info[:3])) == '${PYTHON_VERSION}'; print('managed python:', sys.version)" \
    && python3 -c "import sys; assert '.'.join(map(str, sys.version_info[:3])) == '${PYTHON_VERSION}'"

# Python package floor — everything the starter skills import, baked into the
# managed interpreter so bare `python3` needs no per-script resolution or
# runtime downloads. Pins live in runtime-versions.json (`pythonPackages`);
# `uv run --with` stays the escape hatch for packages outside the floor.
# `--break-system-packages` overrides uv's externally-managed marker on the
# interpreter installed above — our frozen build-time interpreter, not a
# distro Python. The interpreter is named by EXPLICIT PATH: `--system` skips
# uv-managed interpreters and would resolve the distro python3 that
# LibreOffice's apt deps drag in. Unquoted $(...) expansion is safe here: pins
# contain no whitespace, and the `markitdown[pptx]` glob matches no file here.
RUN uv pip install --python /home/kortix/.local/bin/python3 --break-system-packages \
        $(python3 -c "import json; print(' '.join(f'{k}=={v}' for k, v in sorted(json.load(open('/tmp/kortix-runtime-versions.json'))['pythonPackages'].items())))") \
    && python3 -c "import importlib; [importlib.import_module(m) for m in ['PIL', 'docx', 'fitz', 'lxml', 'markitdown', 'openpyxl', 'pandas', 'pdf2docx', 'pdf2image', 'pdfplumber', 'playwright', 'pptx', 'pypdf', 'pypdfium2', 'pytesseract', 'reportlab']]; print('python package floor OK')"

ENV SHELL=/bin/bash \
    DISABLE_AUTOUPDATER=1 \
    DISABLE_UPDATES=1
RUN PNPM_VERSION="$(python -c "import json; print(json.load(open('/tmp/kortix-runtime-versions.json'))['pnpm'])")" \
    && NODE_VERSION="$(python -c "import json; print(json.load(open('/tmp/kortix-runtime-versions.json'))['node'])")" \
    && NPM_VERSION="$(python -c "import json; print(json.load(open('/tmp/kortix-runtime-versions.json'))['npm'])")" \
    && PNPM_SHA256_AMD64="$(python -c "import json; print(json.load(open('/tmp/kortix-runtime-versions.json'))['pnpmSha256Amd64'])")" \
    && PNPM_SHA256_ARM64="$(python -c "import json; print(json.load(open('/tmp/kortix-runtime-versions.json'))['pnpmSha256Arm64'])")" \
    && case "$(uname -m)" in \
         x86_64) pnpm_arch=x64; pnpm_sha="$PNPM_SHA256_AMD64" ;; \
         aarch64|arm64) pnpm_arch=arm64; pnpm_sha="$PNPM_SHA256_ARM64" ;; \
         *) echo "unsupported pnpm architecture: $(uname -m)" >&2; exit 1 ;; \
       esac \
    && curl -fsSL --retry 3 --retry-delay 2 -o /tmp/pnpm.tar.gz \
         "https://github.com/pnpm/pnpm/releases/download/v${PNPM_VERSION}/pnpm-linux-${pnpm_arch}.tar.gz" \
    && echo "${pnpm_sha}  /tmp/pnpm.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/pnpm.tar.gz -C /home/kortix/.local/bin \
    && rm /tmp/pnpm.tar.gz \
    && test "$(pnpm --version)" = "$PNPM_VERSION" \
    && pnpm runtime set node "$NODE_VERSION" -g \
    && test "$(node --version)" = "v${NODE_VERSION}" \
    && pnpm add -g "npm@${NPM_VERSION}" \
    && test "$(npm --version)" = "$NPM_VERSION"

ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers \
    AGENT_BROWSER_EXECUTABLE_PATH=/home/kortix/.local/bin/chromium \
    AGENT_BROWSER_ARGS=--no-sandbox,--disable-dev-shm-usage \
    PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT=1800000
RUN AGENT_BROWSER_VERSION="$(node -e "console.log(require('/tmp/kortix-runtime-versions.json').agentBrowser)")" \
    && PLAYWRIGHT_VERSION="$(node -e "console.log(require('/tmp/kortix-runtime-versions.json').playwright)")" \
    && pnpm add -g --allow-build=agent-browser "agent-browser@${AGENT_BROWSER_VERSION}" \
    && agent-browser --version \
    && for pw_try in 1 2 3 4 5; do \
        pnpm dlx playwright@${PLAYWRIGHT_VERSION} install --with-deps chromium && break; \
        echo "playwright chromium install attempt $pw_try failed, retrying..."; \
        sleep $((pw_try*10)); \
    done \
    && sudo rm -rf /var/lib/apt/lists/* \
    && pw_chrome="$(find /opt/pw-browsers -type f -path '*chrome-linux*/chrome' | head -n1)" \
    && test -n "$pw_chrome" \
    && ln -sf "$pw_chrome" /home/kortix/.local/bin/chromium \
    && mkdir -p /home/kortix/.agent-browser/browsers \
    && ln -sf "$(dirname "$pw_chrome")" /home/kortix/.agent-browser/browsers/chrome-linux64 \
    && chromium --version \
    && env -u AGENT_BROWSER_EXECUTABLE_PATH agent-browser doctor 2>&1 | grep -qE 'pass.+chrome-linux64/chrome'

# The Pi harness invokes these as environment tools. Download only the current
# architecture from each publisher's official npm package. Repository-owned
# SHA-256 pins protect the artifact path without executing an installer script.
# Keep Codex's complete vendor tree because its sandbox and search resources sit
# beside the main executable. The image-wide Claude update guards keep this pin
# stable after startup.
RUN CODEX_CLI_VERSION="$(node -e "console.log(require('/tmp/kortix-runtime-versions.json').codexCli)")" \
    && CLAUDE_CODE_VERSION="$(node -e "console.log(require('/tmp/kortix-runtime-versions.json').claudeCode)")" \
    && CODEX_CLI_SHA256_AMD64="$(node -e "console.log(require('/tmp/kortix-runtime-versions.json').codexCliSha256Amd64)")" \
    && CODEX_CLI_SHA256_ARM64="$(node -e "console.log(require('/tmp/kortix-runtime-versions.json').codexCliSha256Arm64)")" \
    && CLAUDE_CODE_SHA256_AMD64="$(node -e "console.log(require('/tmp/kortix-runtime-versions.json').claudeCodeSha256Amd64)")" \
    && CLAUDE_CODE_SHA256_ARM64="$(node -e "console.log(require('/tmp/kortix-runtime-versions.json').claudeCodeSha256Arm64)")" \
    && case "$(uname -m)" in \
         x86_64) cli_arch=x64; codex_target=x86_64-unknown-linux-musl; codex_sha="$CODEX_CLI_SHA256_AMD64"; claude_sha="$CLAUDE_CODE_SHA256_AMD64" ;; \
         aarch64|arm64) cli_arch=arm64; codex_target=aarch64-unknown-linux-musl; codex_sha="$CODEX_CLI_SHA256_ARM64"; claude_sha="$CLAUDE_CODE_SHA256_ARM64" ;; \
         *) echo "unsupported agent CLI architecture: $(uname -m)" >&2; exit 1 ;; \
       esac \
    && curl -fsSL --retry 3 --retry-delay 2 -o /tmp/codex.tgz \
         "https://registry.npmjs.org/@openai/codex/-/codex-${CODEX_CLI_VERSION}-linux-${cli_arch}.tgz" \
    && echo "${codex_sha}  /tmp/codex.tgz" | sha256sum -c - \
    && rm -rf /opt/kortix/codex \
    && mkdir -p /opt/kortix/codex \
    && tar -xzf /tmp/codex.tgz --strip-components=1 -C /opt/kortix/codex \
    && ln -sfn "/opt/kortix/codex/vendor/${codex_target}/bin/codex" /home/kortix/.local/bin/codex \
    && test -x "/opt/kortix/codex/vendor/${codex_target}/codex-resources/bwrap" \
    && test -x "/opt/kortix/codex/vendor/${codex_target}/codex-path/rg" \
    && curl -fsSL --retry 3 --retry-delay 2 -o /tmp/claude-code.tgz \
         "https://registry.npmjs.org/@anthropic-ai/claude-code-linux-${cli_arch}/-/claude-code-linux-${cli_arch}-${CLAUDE_CODE_VERSION}.tgz" \
    && echo "${claude_sha}  /tmp/claude-code.tgz" | sha256sum -c - \
    && tar -xzf /tmp/claude-code.tgz -O package/claude > /home/kortix/.local/bin/claude \
    && chmod 0755 /home/kortix/.local/bin/claude \
    && rm /tmp/codex.tgz /tmp/claude-code.tgz \
    && test "$(codex --version)" = "codex-cli ${CODEX_CLI_VERSION}" \
    && test "$(claude --version)" = "${CLAUDE_CODE_VERSION} (Claude Code)"

RUN OPENCODE_VERSION="$(node -e "console.log(require('/tmp/kortix-runtime-versions.json').opencode)")" \
    && pnpm add -g --allow-build=opencode-ai "opencode-ai@${OPENCODE_VERSION}" \
    && command -v opencode \
    && opencode --version \
    && opencode_native="$(sed -n 's/^# cmd-shim-target=//p' "$(command -v opencode)" | tail -n 1)" \
    && test -x "$opencode_native" \
    && test "$(wc -c < "$opencode_native")" -gt 50000000 \
    && test "$("$opencode_native" --version)" = "$OPENCODE_VERSION" \
    && ln -sfn "$opencode_native" /opt/kortix/opencode.current \
    && sudo ln -sfn /opt/kortix/opencode.current /usr/local/bin/opencode-kortix \
    && test "$(/usr/local/bin/opencode-kortix --version)" = "$OPENCODE_VERSION"

RUN BUN_VERSION="$(node -e "console.log(require('/tmp/kortix-runtime-versions.json').bun)")" \
    && BUN_SHA256_AMD64="$(node -e "console.log(require('/tmp/kortix-runtime-versions.json').bunSha256Amd64)")" \
    && BUN_SHA256_ARM64="$(node -e "console.log(require('/tmp/kortix-runtime-versions.json').bunSha256Arm64)")" \
    && case "$(uname -m)" in \
         x86_64) bun_arch=x64; bun_sha="$BUN_SHA256_AMD64" ;; \
         aarch64|arm64) bun_arch=aarch64; bun_sha="$BUN_SHA256_ARM64" ;; \
         *) echo "unsupported Bun architecture: $(uname -m)" >&2; exit 1 ;; \
       esac \
    && curl -fsSL --retry 3 --retry-delay 2 -o /tmp/bun.zip \
         "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-${bun_arch}.zip" \
    && echo "${bun_sha}  /tmp/bun.zip" | sha256sum -c - \
    && unzip -q /tmp/bun.zip -d /tmp/bun \
    && install -m 0755 "/tmp/bun/bun-linux-${bun_arch}/bun" /home/kortix/.bun/bin/bun \
    && ln -sf bun /home/kortix/.bun/bin/bunx \
    && rm -rf /tmp/bun /tmp/bun.zip \
    && test "$(bun --version)" = "$BUN_VERSION"

# anydoc (Firecrawl) — document→Markdown converter for the
# convert-documents-to-markdown skill. Prebuilt napi binaries; no build scripts.
RUN ANYDOC_VERSION="$(node -e "console.log(require('/tmp/kortix-runtime-versions.json').anydoc)")" \
    && pnpm add -g "@firecrawl/anydoc@${ANYDOC_VERSION}" \
    && command -v anydoc \
    && test "$(anydoc --version)" = "$ANYDOC_VERSION"

RUN mkdir -p /opt/kortix/opencode-config-deps \
    && cd /opt/kortix/opencode-config-deps \
    && OPENCODE_VERSION="$(node -e "console.log(require('/tmp/kortix-runtime-versions.json').opencode)")" \
    && printf '{"name":"kortix-opencode-config","private":true,"dependencies":{"@mendable/firecrawl-js":"^4.25.1","@opencode-ai/plugin":"%s","@tavily/core":"^0.7.3","replicate":"^1.4.0"},"overrides":{"axios":"1.18.0","form-data":"4.0.6"}}' "${OPENCODE_VERSION}" > package.json \
    && bun install \
    && bun build node_modules/axios/lib/utils.js node_modules/form-data/lib/form_data.js --target=bun --outdir=/tmp/opencode-deps-bundle-check \
    && rm -rf /tmp/opencode-deps-bundle-check

USER root
COPY --from=builder /repo/apps/kortix-sandbox-agent-server/dist/kortix-agent /usr/local/bin/kortix-agent
# The admin CLI every in-sandbox agent reaches for: `kortix cr open`,
# `kortix secrets`, `kortix sessions`, … Pre-authenticated at runtime via the
# project-scoped token the platform injects (KORTIX_TOKEN).
COPY --from=cli-builder /cli/kortix /usr/local/bin/kortix
# Always-latest managed Kortix skills (kortix-cli + the kortix-* family). The
# agent server overlays these into every session's OpenCode skills dir at boot
# (see injected-skills.ts) so no project ever goes stale on Kortix internals.
COPY --from=cli-builder /cli/managed-skills /opt/kortix/managed-skills
COPY apps/sandbox/entrypoint.sh /usr/local/bin/kortix-entrypoint
COPY apps/sandbox/MACHINE.md /MACHINE.md
# Channel shims delegate Connector calls to the compiled `kortix` CLI.
COPY apps/sandbox/slack-cli/ /opt/kortix/apps/sandbox/slack-cli/
# The daemon converges the CLI in place at /usr/local/bin/kortix (runtime-assets.ts
# DEFAULT_CLI_PATH) and runs as kortix: the file must belong to that user or every
# box reports `cli: failed` (EACCES) on its first convergence pass.
RUN chmod +x /usr/local/bin/kortix-agent /usr/local/bin/kortix /usr/local/bin/kortix-entrypoint /opt/kortix/apps/sandbox/slack-cli/install-shims.sh \
    && bash /opt/kortix/apps/sandbox/slack-cli/install-shims.sh /opt/kortix/apps/sandbox/slack-cli \
    && kortix --version \
    && chown -R kortix:kortix /opt/kortix /workspace /ephemeral \
    && chown kortix:kortix /usr/local/bin/kortix

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
USER kortix
WORKDIR /workspace

EXPOSE 8000

ENTRYPOINT ["/usr/local/bin/kortix-entrypoint"]

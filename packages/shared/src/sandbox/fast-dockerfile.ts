import {
  BUN_SHA256_AMD64,
  BUN_SHA256_ARM64,
  BUN_VERSION,
  NODE_VERSION,
  NPM_VERSION,
  OPENCODE_VERSION,
  PNPM_SHA256_AMD64,
  PNPM_SHA256_ARM64,
  PNPM_VERSION,
  UV_SHA256_AMD64,
  UV_SHA256_ARM64,
  UV_VERSION,
} from '../runtime-versions';

export interface FastSandboxDockerfileOptions {
  agentBinaryPath: string;
  cliBinaryPath: string;
  entrypointScriptPath: string;
  opencodeWarmupScriptPath: string;
  machineDocPath: string;
  slackCliPath: string;
  lazyToolsPath: string;
  catalogPath: string;
  managedSkillsPath: string;
  runtimeVersionsPath: string;
  opencodeConfigPath: string;
  scaffoldPath: string;
}

/**
 * Render the experimental cold-boot runtime.
 *
 * The image contains only bytes required before the first agent turn. Large
 * browser, document, TeX, and Python package floors install on first use through
 * the staged lazy-tool wrappers. The standard image remains the default.
 */
export function buildFastSandboxDockerfile(options: FastSandboxDockerfileOptions): string {
  return `# syntax=docker/dockerfile:1.7
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates curl file git gzip iproute2 iputils-ping jq less \
      libatomic1 openssh-client procps ripgrep sudo tmux unzip util-linux xz-utils \
 && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --shell /bin/bash --user-group kortix \
 && echo 'kortix ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/kortix \
 && chmod 0440 /etc/sudoers.d/kortix \
 && mkdir -p /workspace /opt/kortix /opt/pw-browsers /ephemeral/kortix-master/opencode \
      /home/kortix/.local/bin /home/kortix/.local/share/pnpm/bin /home/kortix/.bun/bin \
 && chown -R kortix:kortix /workspace /opt/kortix /opt/pw-browsers /ephemeral /home/kortix

ENV PNPM_HOME=/home/kortix/.local/share/pnpm \
    PATH="/home/kortix/.local/bin:/home/kortix/.local/share/pnpm/bin:/home/kortix/.bun/bin:\${PATH}" \
    SHELL=/bin/bash

RUN case "$(uname -m)" in \
      x86_64) pnpm_arch=x64; pnpm_sha=${PNPM_SHA256_AMD64} ;; \
      aarch64|arm64) pnpm_arch=arm64; pnpm_sha=${PNPM_SHA256_ARM64} ;; \
      *) echo "unsupported pnpm architecture: $(uname -m)" >&2; exit 1 ;; \
    esac \
 && curl -fsSL --retry 3 --retry-delay 2 -o /tmp/pnpm.tar.gz \
      "https://github.com/pnpm/pnpm/releases/download/v${PNPM_VERSION}/pnpm-linux-\${pnpm_arch}.tar.gz" \
 && echo "\${pnpm_sha}  /tmp/pnpm.tar.gz" | sha256sum -c - \
 && tar -xzf /tmp/pnpm.tar.gz -C /home/kortix/.local/bin \
 && rm /tmp/pnpm.tar.gz \
 && test "$(pnpm --version)" = "${PNPM_VERSION}" \
 && HOME=/home/kortix pnpm runtime set node ${NODE_VERSION} --global \
 && test "$(node --version)" = "v${NODE_VERSION}" \
 && HOME=/home/kortix pnpm add --global "npm@${NPM_VERSION}" \
 && test "$(npm --version)" = "${NPM_VERSION}" \
 && HOME=/home/kortix pnpm add --global --allow-build=opencode-ai "opencode-ai@${OPENCODE_VERSION}" \
 && test "$(opencode --version)" = "${OPENCODE_VERSION}" \
 && opencode_package="$(pnpm list -g --parseable --depth 0 opencode-ai | sed -n '\\#/node_modules/opencode-ai$#p' | tail -n 1)" \
 && opencode_native="$opencode_package/bin/opencode.exe" \
 && test -x "$opencode_native" \
 && test "$(wc -c < "$opencode_native")" -gt 50000000 \
 && test "$("$opencode_native" --version)" = "${OPENCODE_VERSION}" \
 && ln -sfn "$opencode_native" /opt/kortix/opencode.current \
 && ln -sfn /opt/kortix/opencode.current /usr/local/bin/opencode-kortix \
 && test "$(/usr/local/bin/opencode-kortix --version)" = "${OPENCODE_VERSION}" \
 && ln -sf "$(command -v node)" /usr/local/bin/node \
 && chown -R kortix:kortix /home/kortix

RUN case "$(uname -m)" in \
      x86_64) bun_arch=x64; bun_sha=${BUN_SHA256_AMD64} ;; \
      aarch64|arm64) bun_arch=aarch64; bun_sha=${BUN_SHA256_ARM64} ;; \
      *) echo "unsupported Bun architecture: $(uname -m)" >&2; exit 1 ;; \
    esac \
 && curl -fsSL --retry 3 --retry-delay 2 -o /tmp/bun.zip \
      "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-\${bun_arch}.zip" \
 && echo "\${bun_sha}  /tmp/bun.zip" | sha256sum -c - \
 && unzip -q /tmp/bun.zip -d /tmp/bun \
 && install -m 0755 "/tmp/bun/bun-linux-\${bun_arch}/bun" /home/kortix/.bun/bin/bun \
 && ln -sf bun /home/kortix/.bun/bin/bunx \
 && rm -rf /tmp/bun /tmp/bun.zip \
 && test "$(/home/kortix/.bun/bin/bun --version)" = "${BUN_VERSION}"

RUN case "$(uname -m)" in \
      x86_64) uv_arch=x86_64; uv_sha=${UV_SHA256_AMD64} ;; \
      aarch64|arm64) uv_arch=aarch64; uv_sha=${UV_SHA256_ARM64} ;; \
      *) echo "unsupported uv architecture: $(uname -m)" >&2; exit 1 ;; \
    esac \
 && curl -fsSL --retry 3 --retry-delay 2 -o /tmp/uv.tar.gz \
      "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-\${uv_arch}-unknown-linux-gnu.tar.gz" \
 && echo "\${uv_sha}  /tmp/uv.tar.gz" | sha256sum -c - \
 && tar -xzf /tmp/uv.tar.gz --strip-components=1 -C /home/kortix/.local/bin \
 && rm /tmp/uv.tar.gz \
 && /home/kortix/.local/bin/uv --version | grep -Eq "^uv ${UV_VERSION}( |$)"

RUN mkdir -p /opt/kortix/opencode-config-deps
COPY --chown=kortix:kortix ${options.opencodeConfigPath}/package.json ${options.opencodeConfigPath}/bun.lock /opt/kortix/opencode-config-deps/
RUN cd /opt/kortix/opencode-config-deps \
 && /home/kortix/.bun/bin/bun install --frozen-lockfile \
 && test -d node_modules/zod \
 && test ! -e node_modules/@opencode-ai/plugin \
 && test ! -e node_modules/effect \
 && test ! -e node_modules/@mendable/firecrawl-js \
 && test ! -e node_modules/@tavily/core \
 && test ! -e node_modules/replicate

COPY --chown=kortix:kortix ${options.opencodeWarmupScriptPath} /tmp/kortix-opencode-warmup
RUN sudo -u kortix env HOME=/home/kortix PATH="${'$'}{PATH}" \
      bash /tmp/kortix-opencode-warmup migration

COPY --chown=kortix:kortix ${options.scaffoldPath}/ /opt/kortix/scaffold.git/
RUN sudo -u kortix env HOME=/home/kortix PATH="${'$'}{PATH}" \
      git clone -q /opt/kortix/scaffold.git /workspace \
 && printf '%s\\n' \
      '{"name":"kortix-opencode-config","version":"0.0.0","lockfileVersion":3,"requires":true,"kortixOpenCodeInstallSentinel":1,"packages":{"":{"dependencies":{"@opencode-ai/plugin":"*","zod":"4.1.8"}}}}' \
      | sudo -u kortix tee /workspace/.kortix/opencode/package-lock.json >/dev/null

COPY --chown=kortix:kortix ${options.opencodeConfigPath}/ /ephemeral/kortix-master/opencode/
COPY --chown=kortix:kortix ${options.opencodeConfigPath}/ /opt/kortix/warm-config/.kortix/opencode/
RUN cd /opt/kortix/warm-config/.kortix/opencode \
 && rm -rf node_modules \
 && ln -s /opt/kortix/opencode-config-deps/node_modules node_modules \
 && /home/kortix/.bun/bin/bun build tools/*.ts --target=bun --outdir=/tmp/opencode-tools-bundle-check \
 && rm -rf /tmp/opencode-tools-bundle-check
RUN sudo -u kortix env HOME=/home/kortix PATH="${'$'}{PATH}" \
      bash /tmp/kortix-opencode-warmup instance keep \
 && test -z "$(sudo -u kortix env HOME=/home/kortix git -C /workspace status --porcelain --untracked-files=no)" \
 && test "$(sudo -u kortix env HOME=/home/kortix git -C /workspace rev-parse HEAD)" = "$(sudo -u kortix env HOME=/home/kortix git --git-dir=/opt/kortix/scaffold.git rev-parse HEAD)" \
 && rm -f /tmp/kortix-opencode-warmup
COPY --chown=kortix:kortix ${options.catalogPath} /opt/kortix/llm-catalog.json
COPY --chown=kortix:kortix ${options.managedSkillsPath}/ /opt/kortix/managed-skills/
COPY --chown=kortix:kortix ${options.runtimeVersionsPath} /opt/kortix/runtime-versions.json
COPY --chown=kortix:kortix ${options.lazyToolsPath}/ /opt/kortix/lazy-tools/
COPY ${options.machineDocPath} /MACHINE.md
COPY ${options.entrypointScriptPath} /usr/local/bin/kortix-entrypoint
COPY ${options.slackCliPath}/ /opt/kortix/apps/sandbox/slack-cli/
COPY ${options.agentBinaryPath} /tmp/kortixd.gz
COPY ${options.cliBinaryPath} /tmp/kortix.gz

RUN gzip -dc /tmp/kortixd.gz > /usr/local/bin/kortixd \
 && ln -sfn /usr/local/bin/kortixd /usr/local/bin/kortix-agent \
 && gzip -dc /tmp/kortix.gz > /usr/local/bin/kortix \
 && rm /tmp/kortixd.gz /tmp/kortix.gz \
 && chmod 0755 /usr/local/bin/kortixd /usr/local/bin/kortix /usr/local/bin/kortix-entrypoint \
      /opt/kortix/lazy-tools/install /opt/kortix/apps/sandbox/slack-cli/install-shims.sh \
 && ln -sf /opt/kortix/lazy-tools/install /usr/local/bin/kortix-toolpack \
 && for tool in python python3 make gcc g++ cc c++ pkg-config chromium agent-browser anydoc libreoffice pandoc pdftotext qpdf tesseract ffmpeg latexmk; do \
      ln -sf /opt/kortix/lazy-tools/install "/usr/local/bin/\${tool}"; \
    done \
 && bash /opt/kortix/apps/sandbox/slack-cli/install-shims.sh /opt/kortix/apps/sandbox/slack-cli \
 && bash -n /usr/local/bin/kortix-entrypoint \
 && bash -n /opt/kortix/lazy-tools/install

RUN printf '%s\\n' '[ -r /dev/shm/kortix/agent-env.sh ] && . /dev/shm/kortix/agent-env.sh' \
      > /etc/profile.d/kortix-agent-env.sh \
 && printf '%s\\n' '[ -r /dev/shm/kortix/agent-env.sh ] && . /dev/shm/kortix/agent-env.sh' \
      >> /etc/bash.bashrc

ENV KORTIX_WORKSPACE=/workspace \
    KORTIX_PROJECT_AUTO_CLONE=1 \
    KORTIX_RUNTIME_PROFILE=fast \
    KORTIX_LLM_CATALOG_FILE=/opt/kortix/llm-catalog.json \
    PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers \
    AGENT_BROWSER_EXECUTABLE_PATH=/home/kortix/.local/bin/chromium \
    AGENT_BROWSER_ARGS=--no-sandbox,--disable-dev-shm-usage
USER kortix
WORKDIR /workspace
EXPOSE 8000
ENTRYPOINT ["/usr/local/bin/kortix-entrypoint"]
`;
}

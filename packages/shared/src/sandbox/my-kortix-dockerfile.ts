import {
  NODE_VERSION,
  PNPM_SHA256_AMD64,
  PNPM_SHA256_ARM64,
  PNPM_VERSION,
} from '../runtime-versions';
import { kortixShellProfileRun } from './dockerfile-layer';
import {
  SANDBOX_SHELL_TOOL_APT_LIST,
  SANDBOX_SHELL_TOOL_LINK_COMMAND,
} from './shell-tools';
import {
  SANDBOX_CLI_OWNERSHIP_COMMAND,
  SANDBOX_MANAGED_SKILLS_DIR,
  SANDBOX_RUNTIME_ASSETS_STATE_COMMAND,
  SANDBOX_RUNTIME_ASSETS_STATE_PATH,
} from './platform-binaries';

export interface MyKortixSandboxDockerfileOptions {
  agentBinaryPath: string;
  cliBinaryPath: string;
  entrypointScriptPath: string;
  /** Staged managed `kortix-*` skills dir — overlaid into the harness skills
   *  dir at boot so the coordinator learns the `kortix` CLI properly. */
  managedSkillsPath: string;
}


/**
 * Render the image of My Kortix, the built-in agent (slug `mykortix`).
 *
 * This runtime contains the daemon, Kortix CLI, Git, pnpm and Node.js. It excludes
 * project toolchains because My Kortix delegates project work to another
 * session. Its instructions are not in the image: the API serves them in the
 * compiled config (`MY_KORTIX_PROMPT`, apps/api/src/projects/lib/my-kortix-prompt.ts),
 * so a wording change needs no image rebuild.
 */
export function buildMyKortixSandboxDockerfile(options: MyKortixSandboxDockerfileOptions): string {
  return `# syntax=docker/dockerfile:1.7
FROM debian:bookworm-slim

RUN apt-get update \\
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \\
      ca-certificates curl git gzip libatomic1 sudo util-linux \\
      ${SANDBOX_SHELL_TOOL_APT_LIST} \\
 && rm -rf /var/lib/apt/lists/* \\
 && ${SANDBOX_SHELL_TOOL_LINK_COMMAND}

RUN useradd --create-home --shell /bin/bash kortix \\
 && mkdir -p /workspace /opt/kortix \\
 && chown -R kortix:kortix /workspace /opt/kortix

ENV PNPM_HOME=/home/kortix/.local/share/pnpm \\
    PATH="/home/kortix/.local/bin:/home/kortix/.local/share/pnpm/bin:\${PATH}"
# pnpm comes from its checksum-verified standalone release artifact; the
# public installer script is not part of the trust path.
RUN case "$(uname -m)" in \\
      x86_64) pnpm_arch=x64; pnpm_sha=${PNPM_SHA256_AMD64} ;; \\
      aarch64|arm64) pnpm_arch=arm64; pnpm_sha=${PNPM_SHA256_ARM64} ;; \\
      *) echo "unsupported pnpm architecture: $(uname -m)" >&2; exit 1 ;; \\
    esac \\
 && curl -fsSL --retry 3 --retry-delay 2 -o /tmp/pnpm.tar.gz \\
      "https://github.com/pnpm/pnpm/releases/download/v${PNPM_VERSION}/pnpm-linux-\${pnpm_arch}.tar.gz" \\
 && echo "\${pnpm_sha}  /tmp/pnpm.tar.gz" | sha256sum -c - \\
 && mkdir -p /home/kortix/.local/bin \\
 && tar -xzf /tmp/pnpm.tar.gz -C /home/kortix/.local/bin \\
 && rm /tmp/pnpm.tar.gz \\
 && test "$(HOME=/home/kortix pnpm --version)" = "${PNPM_VERSION}" \\
 && HOME=/home/kortix pnpm runtime set node ${NODE_VERSION} --global \\
 && ln -sf "\$(command -v node)" /usr/local/bin/node \\
 && chown -R kortix:kortix /home/kortix

COPY ${options.agentBinaryPath} /tmp/kortix-agent.gz
COPY ${options.cliBinaryPath} /tmp/kortix.gz
RUN gzip -dc /tmp/kortix-agent.gz > /usr/local/bin/kortix-agent \\
 && gzip -dc /tmp/kortix.gz > /usr/local/bin/kortix \\
 && chmod 0755 /usr/local/bin/kortix-agent /usr/local/bin/kortix \\
 && ${SANDBOX_CLI_OWNERSHIP_COMMAND} \\
 && rm /tmp/kortix-agent.gz /tmp/kortix.gz
COPY ${options.entrypointScriptPath} /usr/local/bin/kortix-entrypoint
RUN chmod 0755 /usr/local/bin/kortix-entrypoint
COPY --chown=kortix:kortix ${options.managedSkillsPath} ${SANDBOX_MANAGED_SKILLS_DIR}
RUN ${SANDBOX_RUNTIME_ASSETS_STATE_COMMAND} \\
 && chown kortix:kortix ${SANDBOX_RUNTIME_ASSETS_STATE_PATH}
${kortixShellProfileRun()}

ENV KORTIX_WORKSPACE=/workspace \\
    KORTIX_PROJECT_AUTO_CLONE=0
WORKDIR /workspace
EXPOSE 8000
ENTRYPOINT ["/usr/local/bin/kortix-entrypoint"]
`;
}

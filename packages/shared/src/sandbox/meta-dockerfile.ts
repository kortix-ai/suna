import { NODE_VERSION, OPENCODE_VERSION, PNPM_VERSION } from '../runtime-versions';

export interface MetaSandboxDockerfileOptions {
  agentBinaryPath: string;
  cliBinaryPath: string;
  entrypointScriptPath: string;
  catalogPath: string;
  /** Staged managed `kortix-*` skills dir — overlaid into the harness skills
   *  dir at boot so the coordinator learns the `kortix` CLI properly. */
  managedSkillsPath: string;
}

export const META_AGENT_GUIDE = [
  '# Kortix Meta Agent',
  '',
  'You coordinate work. You do not perform project work in this sandbox.',
  '',
  '- This sandbox is minimal on purpose: the `kortix` CLI, git, and nothing else.',
  '- Specialized sessions run full sandboxes with Python (via `uv` — tell them to use `uv run`/`uvx`/`uv pip`,',
  '  never bare `pip`), Node, browsers, and document tooling preinstalled. Never plan around what a',
  '  session might be missing — just give it the task.',
  '- Read the `kortix-cli` skill before coordinating; `kortix skills get kortix-system` serves the full,',
  '  always-current CLI reference.',
  '- Use the `kortix` CLI to inspect the current project and its sessions.',
  '- Start a specialized session when the task needs a project runtime or toolchain.',
  '- Give each specialized session one bounded task.',
  '- You are the only coordinator. Specialized sessions do their task themselves and never spawn sessions.',
  '  Always pass the task via `--prompt`; the CLI appends a session contract that tells the worker to do the',
  '  work directly and to write deliverables under /workspace/out/.',
  '- If a task needs another skill, spawn a sibling session yourself — never ask a session to delegate.',
  '- Monitor each specialized session and report its verified result.',
  '- Wait for a session with `kortix sessions wait-for <session-id> --timeout 120` — never poll with sleeps.',
  '  Exit 0 = finished, 3 = blocked on an ask (answer via `kortix sessions pending`), 124 = still working.',
  '- Finished sessions stop automatically to save compute. A stopped session is parked, not failed:',
  '  `sessions chat`, `sessions cp`, and `sessions wait-for` wake it on demand.',
  '- Move files between sessions with `kortix sessions cp <session-id>:<path> <session-id>:<path>`.',
  '  It also copies between this sandbox and a session (`kortix sessions cp local.txt <session-id>:out/local.txt`).',
  '  Paths resolve under /workspace unless absolute. Add -r for directories. The destination path is overwritten.',
  '- To spawn a session with input files, use `kortix sessions new --with-file <local path> --prompt "<task>"`.',
  '  Each file lands in /workspace/incoming/ before the prompt is delivered, and the prompt gets a manifest of the paths.',
  '- To hand a file to a running session: `kortix sessions cp report.pdf <session-id>:incoming/report.pdf`,',
  '  then reference /workspace/incoming/report.pdf in `kortix sessions chat <session-id> --prompt "<task>"`.',
  '- To collect results, pull them from the worker\'s /workspace/out/:',
  '  `kortix sessions cp <session-id>:out/result.pdf result.pdf`.',
  '- Do not install project toolchains in this sandbox.',
  '- Do not clone the project repository into this sandbox.',
  '- Treat this sandbox as disposable.',
  '',
  '`KORTIX_CLI_TOKEN` authenticates the CLI without login or local configuration.',
  'It grants every project action allowed to the user who started this session.',
  'It cannot access another project, account administration, project secrets, or connectors.',
].join('\n');

/**
 * Render the platform meta-agent image.
 *
 * This runtime contains the daemon, Kortix CLI, Git, and OpenCode. It excludes
 * project toolchains because the meta agent delegates project work to another
 * session.
 */
export function buildMetaSandboxDockerfile(options: MetaSandboxDockerfileOptions): string {
  return `# syntax=docker/dockerfile:1.7
FROM debian:bookworm-slim

RUN apt-get update \\
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \\
      ca-certificates curl git gzip libatomic1 sudo util-linux \\
 && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --shell /bin/bash kortix \\
 && mkdir -p /workspace /opt/kortix /ephemeral/kortix-master/opencode \\
 && chown -R kortix:kortix /workspace /opt/kortix /ephemeral

ENV PNPM_HOME=/home/kortix/.local/share/pnpm \\
    PATH="/home/kortix/.local/share/pnpm/bin:\${PATH}"
RUN curl -fsSL https://get.pnpm.io/install.sh \\
      | env HOME=/home/kortix SHELL=/bin/bash PNPM_VERSION=${PNPM_VERSION} sh - \\
 && HOME=/home/kortix pnpm runtime set node ${NODE_VERSION} --global \\
 && HOME=/home/kortix pnpm add --global --allow-build=opencode-ai "opencode-ai@${OPENCODE_VERSION}" \\
 && opencode_package="$(pnpm list -g --parseable --depth 0 opencode-ai | sed -n '\\#/node_modules/opencode-ai$#p' | tail -n 1)" \\
 && opencode_native="$opencode_package/bin/opencode.exe" \\
 && test -x "$opencode_native" \\
 && test "$(wc -c < "$opencode_native")" -gt 50000000 \\
 && test "$("$opencode_native" --version)" = "${OPENCODE_VERSION}" \\
 && ln -sfn "$opencode_native" /opt/kortix/opencode.current \\
 && ln -sfn /opt/kortix/opencode.current /usr/local/bin/opencode-kortix \\
 && test "$(/usr/local/bin/opencode-kortix --version)" = "${OPENCODE_VERSION}" \\
 && ln -sf "\$(command -v node)" /usr/local/bin/node \\
 && chown -R kortix:kortix /home/kortix

COPY ${options.agentBinaryPath} /tmp/kortixd.gz
COPY ${options.cliBinaryPath} /tmp/kortix.gz
RUN gzip -dc /tmp/kortixd.gz > /usr/local/bin/kortixd \\
 && ln -sfn /usr/local/bin/kortixd /usr/local/bin/kortix-agent \\
 && gzip -dc /tmp/kortix.gz > /usr/local/bin/kortix \\
 && chmod 0755 /usr/local/bin/kortixd /usr/local/bin/kortix \\
 && rm /tmp/kortixd.gz /tmp/kortix.gz
COPY ${options.entrypointScriptPath} /usr/local/bin/kortix-entrypoint
RUN chmod 0755 /usr/local/bin/kortix-entrypoint
COPY --chown=kortix:kortix <<'KORTIX_META_AGENT_GUIDE' /workspace/AGENTS.md
${META_AGENT_GUIDE}
KORTIX_META_AGENT_GUIDE
COPY --chown=kortix:kortix ${options.catalogPath} /opt/kortix/llm-catalog.json
COPY --chown=kortix:kortix ${options.managedSkillsPath} /opt/kortix/managed-skills

ENV KORTIX_WORKSPACE=/workspace \\
    KORTIX_PROJECT_AUTO_CLONE=0 \\
    KORTIX_OPENCODE_PROCESS_TRANSPORT=rest \\
    KORTIX_LLM_CATALOG_FILE=/opt/kortix/llm-catalog.json
WORKDIR /workspace
EXPOSE 8000
ENTRYPOINT ["/usr/local/bin/kortix-entrypoint"]
`;
}

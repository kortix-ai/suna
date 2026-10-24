import {
  NODE_VERSION,
  OPENCODE_VERSION,
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
  SANDBOX_OPENCODE_GLOBAL_CONFIG_COMMAND,
  SANDBOX_RUNTIME_ASSETS_STATE_COMMAND,
  SANDBOX_RUNTIME_ASSETS_STATE_PATH,
} from './platform-binaries';

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
  '# My Kortix',
  '',
  'You are My Kortix: the one agent this person talks to in this project. Every other agent',
  'is a work product you run for them. You understand what they want, run the platform and',
  'its agents on their behalf, and report the verified result in your own words.',
  '',
  '## Your authority',
  '',
  '`KORTIX_TOKEN` authenticates the CLI without login or local configuration.',
  'It grants every project action allowed to the user who started this session.',
  'It cannot access another project, account administration, project secrets, or connectors.',
  'It cannot mint tokens. You never hold more than the user does in this project.',
  'On a 403, say what was refused and who can grant it (`kortix whoami`). Never work around a denial.',
  '',
  '## Do it yourself, or delegate',
  '',
  'Do yourself: answer questions about the project, its agents, sessions, goals, spaces, usage and',
  'configuration with `kortix` reads; configure agents and spaces.',
  'Delegate: every production task (code, research, documents, browsing, connector work) to a',
  'session of the narrowest project agent. NEVER do project work in this sandbox: it has no project',
  'checkout and no toolchain on purpose. If there is work, there is a session for it.',
  '',
  '- Read the `kortix-system` skill before you coordinate; `kortix skills get kortix-system` serves the full,',
  '  always-current CLI reference.',
  '- Specialized sessions run full sandboxes with Python (via `uv` — tell them to use `uv run`/`uvx`/`uv pip`,',
  '  never bare `pip`), Node, browsers, and document tooling preinstalled. Never plan around what a',
  '  session might be missing — give it the task.',
  '',
  '## Agents are work products',
  '',
  '- `kortix agents ls --json` lists them. `kortix agents config <name> --json` and',
  '  `kortix agents scope <name> --show` show what each one may use.',
  '- Pick the agent with the least authority that can do the task.',
  '- If none fits, create or narrow one with `kortix agents config <name> --file -` (the whole block as JSON',
  '  on stdin: `behavior.prompt`, `behavior.model`, `tools`, `skills`, `subagents`, `extensions`, `connectors`,',
  '  `secrets`, `apps`, `kortix_permissions`, `space`, `enabled`). Grant only what the task needs.',
  '- Before a change that WIDENS a grant (a connector, a secret, a tool, a `kortix_permissions` item),',
  '  show the user the before and after, and ask once.',
  '- Every change is one commit on the default branch; say which. A 409 for branch protection means',
  '  open a change request instead (`kortix cr open`).',
  '- Your own prompt, tools and model are built in. You cannot edit them.',
  '',
  '## Delegation contract',
  '',
  '- Start a session with `kortix sessions new --agent <name> --prompt "<task>"`: a real, durable cloud',
  '  session linked to this one. Give each session one bounded task.',
  '  The CLI ships a session contract beside the prompt (initial_context) that tells the worker to do the',
  '  work directly and to write deliverables under /workspace/out/.',
  '- Specialized sessions do their task themselves and never spawn sessions.',
  '  The one exception is a goal coordinator (see Goals).',
  '- If a task needs another skill, spawn a sibling session yourself — never ask a session to delegate.',
  '- Wait for a session with `kortix sessions wait-for <session-id> --timeout 120` — never poll with sleeps.',
  '  Exit 0 = finished, 3 = blocked on an ask (answer via `kortix sessions pending`), 124 = still working.',
  '- Finished sessions stop automatically to save compute. A stopped session is parked, not failed:',
  '  `sessions chat`, `sessions cp`, and `sessions wait-for` wake it on demand.',
  '- Move files between sessions with `kortix sessions cp <session-id>:<path> <session-id>:<path>`.',
  '  It also copies between this sandbox and a session (`kortix sessions cp local.txt <session-id>:out/local.txt`).',
  '  Paths resolve under /workspace unless absolute. Add -r for directories. The destination path is overwritten.',
  '- To spawn a session with input files, use `kortix sessions new --with-file <local path> --prompt "<task>"`.',
  '  Each file lands in /workspace/incoming/ before the prompt is delivered, and the prompt gets a manifest of the paths.',
  '- To collect results, pull them from the worker\'s /workspace/out/:',
  '  `kortix sessions cp <session-id>:out/result.pdf result.pdf`.',
  '- Report the verified result, with the session link.',
  '',
  '## Goals',
  '',
  'An objective, not a task ("make sure X", "keep at it until") is a goal. Load the `kortix-goals` skill.',
  '- If /drives is mounted here, this session coordinates: `kortix goals new "<objective>"`.',
  '- Otherwise start one coordinator session for the goal: `kortix sessions new --agent <agent> --prompt',
  '  "Coordinate this goal with the kortix-goals skill: <objective>. Start worker and verifier sessions as',
  '  the skill says."` Track it with `kortix sessions wait-for <session-id>`, and ask it for progress with',
  '  `kortix sessions chat <session-id> --prompt "Run kortix goals status and report."`.',
  '  Never run `kortix goals ls` or `kortix goals status` here: without /drives they refuse.',
  '- Goals need the project features `goals`, `volumes` and `reminders`. The CLI says which one is off.',
  '',
  '## Spaces',
  '',
  'A space is a channel: `spaces.<slug>` in kortix.yaml. Its first tab is always its room; `tabs` lists the rest',
  '(goals, apps, artifacts, files+path, board+blocks, app+app, artifact+artifact, link+url), and `header` picks',
  'what the header shows. An agent joins it with `agents.<name>.space` (`kortix agents config <name> --set space=<slug>`).',
  'The kortix-system skill (references/kortix/kortix-yaml.md, "Spaces") has the full shape. Load `kortix-rooms` for the room.',
  'This sandbox has no checkout, so a `spaces:` edit is a task: delegate it to a session of an agent with repository',
  'access ("edit spaces.<slug>, run `kortix validate`, open a change request"), then merge it with `kortix cr merge <id>`',
  'when the user agrees.',
  '',
  '## Bind what you create',
  '',
  'Every App, Artifact or Goal you create names the agent or the space it belongs to.',
  '',
  '## This sandbox',
  '',
  '- This sandbox is minimal on purpose: the `kortix` CLI, git, and shell tools (rg, fd, jq). Nothing else.',
  '- Do not install project toolchains in this sandbox.',
  '- Do not clone the project repository into this sandbox.',
  '- Treat this sandbox as disposable.',
  '',
  '## Voice',
  '',
  'Lead with the result. Keep it short. Link the sessions, commits and change requests you made.',
].join('\n');

/**
 * Render the image of My Kortix, the built-in agent (slug `meta`).
 *
 * This runtime contains the daemon, Kortix CLI, Git, and OpenCode. It excludes
 * project toolchains because My Kortix delegates project work to another
 * session.
 */
export function buildMetaSandboxDockerfile(options: MetaSandboxDockerfileOptions): string {
  return `# syntax=docker/dockerfile:1.7
FROM debian:bookworm-slim

RUN apt-get update \\
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \\
      ca-certificates curl git gzip libatomic1 sudo util-linux \\
      ${SANDBOX_SHELL_TOOL_APT_LIST} \\
 && rm -rf /var/lib/apt/lists/* \\
 && ${SANDBOX_SHELL_TOOL_LINK_COMMAND}

RUN useradd --create-home --shell /bin/bash kortix \\
 && mkdir -p /workspace /opt/kortix /ephemeral/kortix-master/opencode \\
 && chown -R kortix:kortix /workspace /opt/kortix /ephemeral

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
 && HOME=/home/kortix pnpm add --global --allow-build=opencode-ai "opencode-ai@${OPENCODE_VERSION}" \\
 && opencode_native="$(sed -n 's/^# cmd-shim-target=//p' "$(command -v opencode)" | tail -n 1)" \\
 && test -x "$opencode_native" \\
 && test "$(wc -c < "$opencode_native")" -gt 50000000 \\
 && test "$("$opencode_native" --version)" = "${OPENCODE_VERSION}" \\
 && ln -sfn "$opencode_native" /opt/kortix/opencode.current \\
 && ln -sfn /opt/kortix/opencode.current /usr/local/bin/opencode-kortix \\
 && test "$(/usr/local/bin/opencode-kortix --version)" = "${OPENCODE_VERSION}" \\
 && ln -sf "\$(command -v node)" /usr/local/bin/node \\
 && chown -R kortix:kortix /home/kortix

COPY ${options.agentBinaryPath} /tmp/kortix-agent.gz
COPY ${options.cliBinaryPath} /tmp/kortix.gz
RUN gzip -dc /tmp/kortix-agent.gz > /usr/local/bin/kortix-agent \\
 && gzip -dc /tmp/kortix.gz > /usr/local/bin/kortix \\
 && chmod 0755 /usr/local/bin/kortix-agent /usr/local/bin/kortix \\
 && ${SANDBOX_CLI_OWNERSHIP_COMMAND} \\
 && ${SANDBOX_OPENCODE_GLOBAL_CONFIG_COMMAND} \\
 && rm /tmp/kortix-agent.gz /tmp/kortix.gz
COPY ${options.entrypointScriptPath} /usr/local/bin/kortix-entrypoint
RUN chmod 0755 /usr/local/bin/kortix-entrypoint
COPY --chown=kortix:kortix <<'KORTIX_META_AGENT_GUIDE' /workspace/AGENTS.md
${META_AGENT_GUIDE}
KORTIX_META_AGENT_GUIDE
COPY --chown=kortix:kortix ${options.catalogPath} /opt/kortix/llm-catalog.json
COPY --chown=kortix:kortix ${options.managedSkillsPath} ${SANDBOX_MANAGED_SKILLS_DIR}
RUN ${SANDBOX_RUNTIME_ASSETS_STATE_COMMAND} \\
 && chown kortix:kortix ${SANDBOX_RUNTIME_ASSETS_STATE_PATH}
${kortixShellProfileRun()}

ENV KORTIX_WORKSPACE=/workspace \\
    KORTIX_PROJECT_AUTO_CLONE=0 \\
    KORTIX_OPENCODE_PROCESS_TRANSPORT=rest \\
    KORTIX_LLM_CATALOG_FILE=/opt/kortix/llm-catalog.json
WORKDIR /workspace
EXPOSE 8000
ENTRYPOINT ["/usr/local/bin/kortix-entrypoint"]
`;
}

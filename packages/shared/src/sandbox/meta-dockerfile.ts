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
  '## State and authority',
  '',
  '- Git owns authored goals, status, policy, code, and durable facts. PostgreSQL, accessed through the',
  '  `kortix` CLI, owns contended tasks, claims, transitions, and metric observations. This sandbox owns',
  '  disposable scratch state only; losing it must not lose goal state, task state, evidence, or residue.',
  '- The meta agent can read Git but cannot push any branch or merge a change request (CR). A worker writes',
  '  durable residue on its branch, pushes that branch, and opens a CR. A reviewer or authorized principal merges it.',
  '- This sandbox is minimal on purpose: the `kortix` CLI, git, and nothing else. Do not install project',
  '  toolchains or clone the project here. Treat this sandbox as disposable.',
  '- Specialized sessions have full project sandboxes with Python (via `uv` — use `uv run`/`uvx`/`uv pip`,',
  '  never bare `pip`), Node, browsers, and document tooling. Give the worker the task; do not plan around',
  '  coordinator-sandbox limitations.',
  '- Read the `kortix-cli` skill first. `kortix skills get kortix-system` serves the current CLI reference.',
  '',
  '## Required control loop',
  '',
  'Repeat this loop while the Git-authored goal status is `active`:',
  '',
  '1. Recover the active goal, its `done_when`, status, metrics, recent observations, and durable tasks with',
  '   `kortix goals` and `kortix tasks`. Never reconstruct authoritative state from chat or sandbox files.',
  '   A declared metric with no observation is `unmeasurable`, never `on_track`.',
  '   Three consecutive goal-push observations with the same value are `stalled`.',
  '   In either case, create a bounded measurement or diagnosis task instead of claiming progress.',
  '   A stall is not completion and does not stop the next trigger wake-up.',
  '2. Select one ready task whose dependencies are done, or create one bounded ready task. Atomically claim',
  '   exactly that task. A failed claim lost the race: select different work. Hold at most one task claim and',
  '   one worker session at a time.',
  '3. Start one bounded ordinary worker session. Include the goal, task ID, acceptance test, verifier, time/token/',
  '   cost/iteration bounds, and claim session ID. The worker performs implementation in its project sandbox,',
  '   writes durable residue through its branch plus CR, returns evidence or a blocker, and never starts a session.',
  '   Only the coordinator session holding a live, unexpired claim can transition the task. Reclaim an expired',
  '   lease before transition. The worker has a different session ID and must not call `kortix tasks done` or',
  '   `kortix tasks block` for the coordinator claim.',
  '4. Wait with `kortix sessions wait-for <session-id> --timeout 120`; never poll with sleeps. Exit 124 means',
  '   still working. Exit 3 means an explicit ask; inspect `kortix sessions pending` and use the existing',
  '   review, question, or channel path. Exit 0 means settled only. Idle, stopped, settled, or a model claim',
  '   never means the task or goal is complete.',
  '5. Read the task, inspect the worker result, and independently verify the resulting external state. The',
  '   coordinator then transitions its claim to `done` with cited verifier evidence, or to `blocked` with the',
  '   delivered blocker. Record the goal observation with its source; use the worker session ID when it produced',
  '   the measurement. A response, transcript, branch, commit, or CR alone is not verifier evidence unless',
  '   `done_when` names it. Completion exists only after the explicit durable `done` transition plus evidence.',
  '6. If the worker settled without evidence or a delivered blocker, send one idempotent, bounded continuation',
  '   to the same session. If it makes no progress again, transition the task to `blocked`,',
  '   record the blocker durably, and escalate through the existing review, question, or channel path.',
  '7. After `done` or `blocked`, release this task from the active loop and immediately recover state and choose',
  '   the next ready task while work exists. Never remain idle after a successful task while ready work exists.',
  '',
  'Missing API keys, secrets, approvals, connectors, tools, or capabilities are delivered blockers. Record the',
  'required capability and failed evidence, block the task, and escalate it. Never convert one into terminal goal',
  'failure. When no ready work remains, leave durable task and observation state, then exit and rely on the existing',
  'goal trigger to wake and recheck. Never create a second scheduler, heartbeat, wake queue, or self-polling loop.',
  '',
  'Goal pushes stop only after `kortix goals` reads an explicit Git status of `achieved`, `paused`, or `abandoned`',
  'with cited external evidence. Until that reviewed Git status lands, the goal remains `active`; blocked or empty',
  'task queues do not complete it.',
  '',
  '## CLI sketch',
  '',
  'Discover the installed command surface before acting:',
  '',
  '```sh',
  'kortix goals --help',
  'kortix tasks --help',
  'kortix sessions --help',
  '```',
  '',
  'The goal/task commands below are executable after replacing uppercase shell values. Inspect JSON before',
  'selecting work; a `todo` task is ready only when every `blocked_by` task is `done`:',
  '',
  '```sh',
  'kortix goals ls --json',
  'kortix goals show "$GOAL_SLUG" --json',
  'kortix goals observations "$GOAL_SLUG" --metric "$METRIC" --json',
  'kortix tasks ls --goal "$GOAL_SLUG" --status todo --json',
  'kortix tasks new --goal "$GOAL_SLUG" --title "$TITLE" --body "$BOUNDS_AND_ACCEPTANCE" --status todo --origin meta --json',
  'kortix tasks claim "$TASK_ID" --session "$COORDINATOR_SESSION_ID" --json',
  'kortix tasks show "$TASK_ID" --json',
  'kortix goals observe "$GOAL_SLUG" --metric "$METRIC" --value "$VALUE" --source "$EVIDENCE_REF" --session "$WORKER_SESSION_ID" --json',
  '# Coordinator after verification:',
  'kortix tasks done "$TASK_ID" --session "$COORDINATOR_SESSION_ID" --evidence "$VERIFIER_REF" --json',
  '# Coordinator after a delivered blocker or failed continuation:',
  'kortix tasks block "$TASK_ID" --session "$COORDINATOR_SESSION_ID" --reason "$BLOCKER" --json',
  '```',
  '',
  'Spawn and wait using the session ID returned by the installed session command. If settled with no progress,',
  'use one `kortix sessions chat` continuation, then block and escalate:',
  '',
  '```sh',
  'kortix sessions new --prompt "Do task $TASK_ID for claim $COORDINATOR_SESSION_ID; return verifier evidence or a blocker; push a worker branch and open a CR; do not transition the task or spawn sessions"',
  'kortix sessions wait-for "$WORKER_SESSION_ID" --timeout 120',
  '```',
  '',
  'Always pass work through `--prompt`; the CLI appends the non-recursive worker contract. To pass files at start,',
  'use `kortix sessions new --with-file <local-path> --prompt "<task>"`. Files land in `/workspace/incoming/`.',
  'Use `kortix sessions cp` for later transfer and collect worker artifacts from `/workspace/out/`.',
  'A stopped worker is parked, not failed; `sessions chat`, `sessions cp`, and `sessions wait-for` wake it.',
  '',
  '`KORTIX_CLI_TOKEN` authenticates the CLI without login or local configuration. It grants only project actions',
  'allowed to the initiating user. It cannot cross projects or bypass account, secret, connector, Git-push, or merge policy.',
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
 && ln -sf "\$(command -v node)" /usr/local/bin/node \\
 && chown -R kortix:kortix /home/kortix

COPY ${options.agentBinaryPath} /tmp/kortix-agent.gz
COPY ${options.cliBinaryPath} /tmp/kortix.gz
RUN gzip -dc /tmp/kortix-agent.gz > /usr/local/bin/kortix-agent \\
 && gzip -dc /tmp/kortix.gz > /usr/local/bin/kortix \\
 && chmod 0755 /usr/local/bin/kortix-agent /usr/local/bin/kortix \\
 && rm /tmp/kortix-agent.gz /tmp/kortix.gz
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

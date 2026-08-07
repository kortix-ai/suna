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
  '3. Start one ordinary worker with `kortix sessions new --json` and no prompt. Then call `kortix tasks worker`',
  '   exactly once with the live claim session ID, returned worker session ID, immutable wall/token/cost/iteration',
  '   bounds, and initial prompt. That task registration atomically binds the worker and durably queues its prompt.',
  '   Never send the initial prompt separately. A `queued` worker state means the durable outbox still owns delivery;',
  '   a `drained` state means the best-effort immediate delivery completed. The worker performs implementation in its',
  '   project sandbox, writes durable residue through its branch plus CR, returns evidence or a blocker. It never starts a session. Only the coordinator holding the live claim can transition the task. The server liveness finalizer owns',
  '   block and claim release after bound exhaustion or expiry. The worker has a different session ID and must not call `kortix tasks done` or',
  '   `kortix tasks block` for the coordinator claim.',
  '4. Wait with `kortix sessions wait-for <session-id> --timeout 120`; never poll with sleeps. An empty new session',
  '   is awaiting initial-prompt delivery and is not settled or no-progress. Exit 124 means still working. Exit 3',
  '   means an explicit ask; inspect `kortix sessions pending` and use the existing review, question, or channel path.',
  '   Exit 0 means settled only. Idle, stopped, settled, or a model claim never means the task or goal is complete.',
  '5. Read the task, inspect the worker result, and independently verify the resulting external state. Record semantic',
  '   residue with `kortix tasks progress` and its evidence ref. The coordinator then transitions its claim to `done`',
  '   with cited verifier evidence, or to `blocked` with the delivered blocker. Record the goal observation with its',
  '   source; use the worker session ID when it produced the measurement. A response, transcript, branch, commit, or',
  '   CR alone is not verifier evidence unless `done_when` names it. Completion exists only after the explicit durable',
  '   `done` transition plus evidence.',
  '6. If the worker settles without evidence or a delivered blocker, call `kortix tasks no-progress` with a stable',
  '   settlement ID for that worker turn. Retry the same settlement ID after any timeout or restart. The first distinct',
  '   settlement durably queues the only continuation to the same worker. A second distinct settlement or exhausted',
  '   bound atomically blocks and releases the task, queues server-owned worker stop, and wakes the coordinator for',
  '   escalation through the existing review, question, or channel path. After restart, read the task fields',
  '   `last_no_progress_settlement_id`, `last_no_progress_action`, and `last_no_progress_command_id` before retrying.',
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
  'Create the empty session, register the task worker, then wait. The registration command owns the initial prompt:',
  '',
  '```sh',
  'kortix sessions new --json',
  '# Optional, before prompt delivery: kortix sessions cp "$LOCAL_FILE" "$WORKER_SESSION_ID:/workspace/incoming/"',
  'kortix tasks worker "$TASK_ID" --session "$COORDINATOR_SESSION_ID" --worker-session "$WORKER_SESSION_ID" --prompt "$BOUNDED_TASK_PROMPT" --max-wall-seconds 900 --max-tokens 50000 --max-cost-usd 2.5 --max-iterations 8 --json',
  'kortix sessions wait-for "$WORKER_SESSION_ID" --timeout 120',
  '# Evidence path:',
  'kortix tasks progress "$TASK_ID" --session "$COORDINATOR_SESSION_ID" --worker-session "$WORKER_SESSION_ID" --ref "$EVIDENCE_REF" --json',
  '# Alternative only when settled without evidence or a delivered blocker:',
  'kortix tasks no-progress "$TASK_ID" --session "$COORDINATOR_SESSION_ID" --worker-session "$WORKER_SESSION_ID" --settlement-id "$STABLE_TURN_ID" --reason "$NO_PROGRESS_REASON" --json',
  '```',
  '',
  'Pass initial work only through `kortix tasks worker --prompt`; do not use `sessions chat` for initial delivery.',
  'Optionally use `kortix sessions cp` after empty session creation and before registration prompt delivery.',
  'Collect worker artifacts from `/workspace/out/`. Never revive a worker stopped by liveness exhaustion or blocking.',
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

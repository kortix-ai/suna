import { NODE_VERSION, OPENCODE_VERSION, PNPM_VERSION } from '../runtime-versions';

export interface AgiSandboxDockerfileOptions {
  agentBinaryPath: string;
  cliBinaryPath: string;
  entrypointScriptPath: string;
  catalogPath: string;
  /** Staged managed `kortix-*` skills dir — overlaid into the harness skills
   *  dir at boot so the coordinator learns the `kortix` CLI properly. */
  managedSkillsPath: string;
}

export const AGI_AGENT_GUIDE = [
  '# Kortix AGI',
  '',
  'You own durable tasks. You coordinate workers and verify their results. You do not perform project work in this sandbox.',
  '',
  '## State and authority',
  '',
  '- PostgreSQL, accessed through the `kortix` CLI, owns tasks, contracts, claims, blockers, reminders, evidence,',
  '  transitions, messages, events, and session lineage. Git owns authored policy, code, durable work residue, and',
  '  optional goal definitions. This sandbox owns disposable scratch state only.',
  '- The AGI agent can read Git but cannot push any branch or merge a change request (CR). A worker writes',
  '  durable residue on its branch, pushes that branch, and opens a CR. A reviewer or authorized principal merges it.',
  '- This sandbox is minimal on purpose: the `kortix` CLI, git, and nothing else. Do not install project',
  '  toolchains or clone the project here. Treat this sandbox as disposable.',
  '- Specialized sessions have full project sandboxes with Python (via `uv` — use `uv run`/`uvx`/`uv pip`,',
  '  never bare `pip`), Node, browsers, and document tooling. Give the worker the task; do not plan around',
  '  coordinator-sandbox limitations.',
  '- Read the `kortix-cli` skill first. `kortix skills get kortix-system` serves the current CLI reference.',
  '## Required task loop',
  '',
  'Start with the task assigned to this coordinator session. Repeat this loop while durable task work exists:',
  '',
  '1. Run `kortix tasks current --json`. If it returns a task, recover that task before selecting anything else.',
  '   Otherwise list ready tasks with `kortix tasks ls --status todo --json`, verify every `blocked_by` dependency',
  '   is `done`, and atomically claim exactly one task. A failed claim lost the race. Hold at most one task claim',
  '   and one worker session at a time. Never reconstruct task state from chat or sandbox files.',
  '2. Read the claimed task, its current contract revision, verification requirements, evidence, blockers, events,',
  '   messages, and session lineage. An open blocker is durable responsibility, not permission to forget the task.',
  '3. Only load goal state when the task has an owning goal. When `goal_slug` is present, read that goal and its',
  '   observations. A declared metric with no observation is `unmeasurable`, never `on_track`. Three consecutive',
  '   goal-push observations with the same value are `stalled`. Create a bounded measurement or diagnosis task',
  '   instead of claiming metric progress. A task without `goal_slug` remains fully valid and executable.',
  '4. Start one ordinary worker with `kortix sessions new --json` and no prompt. Then call `kortix tasks worker`',
  '   exactly once with the live claim session ID, returned worker session ID, immutable wall/token/cost/iteration',
  '   bounds, and initial prompt. That task registration atomically binds the worker and durably queues its prompt.',
  '   Never send the initial prompt separately. A `queued` worker state means the durable outbox still owns delivery;',
  '   a `drained` state means the best-effort immediate delivery completed. The worker performs implementation in its',
  '   project sandbox and returns evidence or a verified human blocker. It never starts another session.',
  '5. Wait with `kortix sessions wait-for <session-id> --timeout 120`; never poll with sleeps. An empty new session',
  '   is awaiting initial-prompt delivery and is not settled or no-progress. Exit 124 means still working. Exit 3',
  '   means an explicit ask; inspect `kortix sessions pending` and use the existing review, question, or channel path.',
  '   Exit 0 means settled only. Idle, stopped, settled, or a model claim never means the task is complete.',
  '6. Read the task again, inspect the worker result, and independently verify the resulting external state. Record',
  '   semantic residue with exactly one of `kortix tasks progress` or `kortix tasks no-progress` for the stable turn',
  '   settlement ID. Progress cites its evidence ref. Add immutable evidence for the current contract revision and',
  '   candidate digest. Then call `kortix tasks submit`; only the server completion gate can mark the task `done`.',
  '   A response, transcript, branch, commit, or CR alone is not verifier evidence unless the task contract names it.',
  '7. When human action is required, verify the coordinator cannot perform it. Create an idempotent typed blocker',
  '   with `kortix tasks blocker`. Include category, requested action, stable request digest, attempts, target, claim',
  '   session, and a bounded `--remind-at`. Add `--expires-at` when the request has a real deadline. Do not use the',
  '   legacy `tasks block` transition. A blocker is delivered only after its durable record and reminder exist.',
  '8. If the worker settles without evidence or a delivered blocker, call `kortix tasks no-progress` with a stable',
  '   settlement ID for that worker turn. Retry the same settlement ID after any timeout or restart. The first distinct',
  '   settlement durably queues the only continuation to the same worker. A second distinct settlement or exhausted',
  '   bound lets the server finalize liveness and wakes the coordinator for escalation. After restart, read the fields',
  '   `last_no_progress_settlement_id`, `last_no_progress_action`, and `last_no_progress_command_id` before retrying.',
  '9. After `done`, `blocked`, or `cancelled`, recover `tasks current` and the ready queue. Select the next ready task',
  '   while work exists. Never remain idle while ready work exists.',
  '',
  'Missing API keys, secrets, approvals, connectors, tools, or capabilities are delivered blockers. Record the',
  'required capability and failed evidence through the typed blocker flow. When no ready work remains, leave durable',
  'task state, then exit and rely on the existing task reminder or trigger. Never create a second scheduler, heartbeat,',
  'wake queue, or self-polling loop.',
  '',
  'When an owning goal exists, record metric observations with their source and worker session. Task completion does',
  'not complete the goal. Goal pushes stop only after reviewed Git status reads `achieved`, `paused`, or `abandoned`',
  'with cited external evidence. A task without an owning goal skips all goal commands.',
  '',
  '## CLI sketch',
  '',
  'Discover the installed command surface before acting:',
  '',
  '```sh',
  'kortix tasks --help',
  'kortix sessions --help',
  'kortix goals --help  # only when the task has goal_slug',
  '```',
  '',
  'The commands below are executable after replacing uppercase shell values:',
  '',
  '```sh',
  'kortix tasks current --json',
  'kortix tasks ls --status todo --json',
  'kortix tasks claim "$TASK_ID" --session "$COORDINATOR_SESSION_ID" --json',
  'kortix tasks show "$TASK_ID" --json',
  'kortix tasks blockers "$TASK_ID" --json',
  'kortix tasks evidence "$TASK_ID" --list --json',
  'kortix tasks events "$TASK_ID" --json',
  'kortix tasks sessions "$TASK_ID" --json',
  '# Coordinator after verification:',
  'kortix tasks evidence "$TASK_ID" --kind command --ref "$VERIFIER_REF" --candidate "$CANDIDATE_DIGEST" --state passed --requirement "$REQUIREMENT_ID" --json',
  'kortix tasks submit "$TASK_ID" --session "$COORDINATOR_SESSION_ID" --candidate "$CANDIDATE_DIGEST" --json',
  '# Coordinator after verified human dependency:',
  'kortix tasks blocker "$TASK_ID" --category "$BLOCKER_CATEGORY" --action "$REQUESTED_ACTION" --digest "$REQUEST_DIGEST" --target-json "$TARGET_JSON" --attempts "$ATTEMPTS" --remind-at "$REMIND_AT" --expires-at "$EXPIRES_AT" --session "$COORDINATOR_SESSION_ID" --json',
  '# Optional goal integration only when task.goal_slug exists:',
  'kortix goals show "$GOAL_SLUG" --json',
  'kortix goals observations "$GOAL_SLUG" --metric "$METRIC" --json',
  'kortix goals observe "$GOAL_SLUG" --metric "$METRIC" --value "$VALUE" --source "$EVIDENCE_REF" --session "$WORKER_SESSION_ID" --json',
  '```',
  '',
  'Create the empty session, register the task worker, then wait. The registration command owns the initial prompt:',
  '',
  '```sh',
  'kortix sessions new --json',
  '# Optional, before prompt delivery: kortix sessions cp "$LOCAL_FILE" "$WORKER_SESSION_ID:/workspace/incoming/"',
  'kortix tasks worker "$TASK_ID" --session "$COORDINATOR_SESSION_ID" --worker-session "$WORKER_SESSION_ID" --prompt "$BOUNDED_TASK_PROMPT" --max-wall-seconds 900 --max-tokens 1000000 --max-cost-usd 2.5 --max-iterations 64 --json',
  'kortix sessions wait-for "$WORKER_SESSION_ID" --timeout 120',
  '# Evidence path:',
  'kortix tasks progress "$TASK_ID" --session "$COORDINATOR_SESSION_ID" --worker-session "$WORKER_SESSION_ID" --settlement-id "$TURN_ID" --ref "$EVIDENCE_REF" --json',
  '# Alternative only when settled without evidence or a delivered blocker:',
  'kortix tasks no-progress "$TASK_ID" --session "$COORDINATOR_SESSION_ID" --worker-session "$WORKER_SESSION_ID" --settlement-id "$STABLE_TURN_ID" --reason "$NO_PROGRESS_REASON" --json',
  '```',
  '',
  'Pass initial work only through `kortix tasks worker --prompt`; do not use `sessions chat` for initial delivery.',
  'Optionally use `kortix sessions cp` after empty session creation and before registration prompt delivery.',
  'Collect worker artifacts from `/workspace/out/`. Never revive a worker stopped by liveness exhaustion.',
  '',
  '`KORTIX_CLI_TOKEN` authenticates the CLI without login or local configuration. It grants only project actions',
  'allowed to the initiating user. It cannot cross projects or bypass account, secret, connector, Git-push, or merge policy.',
].join('\n');

/**
 * Render the platform AGI image.
 *
 * This runtime contains the daemon, Kortix CLI, Git, and OpenCode. It excludes
 * project toolchains because the AGI agent delegates project work to another
 * session.
 */
export function buildAgiSandboxDockerfile(options: AgiSandboxDockerfileOptions): string {
  return `# syntax=docker/dockerfile:1.7
FROM debian:bookworm-slim

RUN apt-get update \\
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \\
      ca-certificates curl git gzip libatomic1 \\
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
COPY --chown=kortix:kortix <<'KORTIX_AGI_AGENT_GUIDE' /workspace/AGENTS.md
${AGI_AGENT_GUIDE}
KORTIX_AGI_AGENT_GUIDE
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

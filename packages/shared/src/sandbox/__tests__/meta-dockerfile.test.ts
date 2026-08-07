import { describe, expect, test } from 'bun:test';

import { META_AGENT_GUIDE, buildMetaSandboxDockerfile } from '../meta-dockerfile';

describe('buildMetaSandboxDockerfile', () => {
  test('contains only the platform coordination runtime', () => {
    const dockerfile = buildMetaSandboxDockerfile({
      agentBinaryPath: 'artifacts/kortix-agent.gz',
      cliBinaryPath: 'artifacts/kortix.gz',
      entrypointScriptPath: 'artifacts/kortix-entrypoint.sh',
      catalogPath: 'artifacts/llm-catalog.json',
      managedSkillsPath: 'artifacts/managed-skills',
    });

    expect(dockerfile).toContain('FROM debian:bookworm-slim');
    expect(dockerfile).toContain('https://get.pnpm.io/install.sh');
    expect(dockerfile).toContain('PNPM_VERSION=11.15.1');
    expect(dockerfile).toContain('pnpm runtime set node 22.23.1 --global');
    expect(dockerfile).toContain('opencode-ai@1.17.11');
    expect(dockerfile).toContain('PNPM_HOME=/home/kortix/.local/share/pnpm');
    expect(dockerfile).toContain('PATH="/home/kortix/.local/share/pnpm/bin:${PATH}"');
    expect(dockerfile).toContain('/usr/local/bin/kortix-agent');
    expect(dockerfile).toContain('/usr/local/bin/kortix');
    expect(dockerfile).toContain('/workspace/AGENTS.md');
    expect(dockerfile).toContain('# Kortix Meta Agent');
    expect(dockerfile).toContain(
      'You coordinate work. You do not perform project work in this sandbox.',
    );
    expect(dockerfile).toContain('Optionally use `kortix sessions cp` after empty session creation');
    expect(dockerfile).toContain('Pass initial work only through `kortix tasks worker --prompt`');
    expect(dockerfile).toContain('never starts a session.');
    expect(dockerfile).toContain(
      'Specialized sessions have full project sandboxes with Python (via `uv` — use `uv run`/`uvx`/`uv pip`,',
    );
    expect(dockerfile).toContain('Read the `kortix-cli` skill first.');
    expect(dockerfile).toContain('Wait with `kortix sessions wait-for <session-id> --timeout 120`');
    expect(dockerfile).toContain('It grants only project actions');
    expect(dockerfile).toContain(
      'It cannot cross projects or bypass account, secret, connector, Git-push, or merge policy.',
    );
    expect(dockerfile).not.toContain('artifacts/AGENTS.md');
    expect(dockerfile).toContain('/ephemeral/kortix-master/opencode');
    expect(dockerfile).toContain('/opt/kortix/llm-catalog.json');
    expect(dockerfile).toContain(
      'COPY --chown=kortix:kortix artifacts/managed-skills /opt/kortix/managed-skills',
    );
    expect(dockerfile).toContain('KORTIX_PROJECT_AUTO_CLONE=0');
    expect(dockerfile).toContain('KORTIX_OPENCODE_PROCESS_TRANSPORT=rest');

    expect(dockerfile).not.toContain('playwright');
    expect(dockerfile).not.toContain('chromium');
    expect(dockerfile).not.toContain('python');
    expect(dockerfile).not.toContain('libreoffice');
    expect(dockerfile).not.toContain('ffmpeg');
    expect(dockerfile).not.toContain('claude-agent-acp');
    expect(dockerfile).not.toContain('codex-acp');
    expect(dockerfile).not.toContain('pi-acp');
    expect(dockerfile).not.toContain('pi-coding-agent');
  });
});

describe('META_AGENT_GUIDE control loop', () => {
  test('recovers authoritative state and claims exactly one ready task', () => {
    expect(META_AGENT_GUIDE).toContain(
      'Recover the active goal, its `done_when`, status, metrics, recent observations, and durable tasks with',
    );
    expect(META_AGENT_GUIDE).toContain('`kortix goals` and `kortix tasks`');
    expect(META_AGENT_GUIDE).toContain('Atomically claim');
    expect(META_AGENT_GUIDE).toContain('exactly that task');
    expect(META_AGENT_GUIDE).toContain('Hold at most one task claim and');
    expect(META_AGENT_GUIDE).toContain('one worker session at a time.');
  });

  test('creates an empty worker then atomically binds bounds and prompt', () => {
    expect(META_AGENT_GUIDE).toContain('`kortix sessions new --json` and no prompt');
    expect(META_AGENT_GUIDE).toContain('Then call `kortix tasks worker`');
    expect(META_AGENT_GUIDE).toContain('immutable wall/token/cost/iteration');
    expect(META_AGENT_GUIDE).toContain('atomically binds the worker and durably queues its prompt');
    expect(META_AGENT_GUIDE).toContain('Never send the initial prompt separately.');
    expect(META_AGENT_GUIDE).toContain('never starts a session.');
  });

  test('keeps terminal task transitions under the coordinator claim session', () => {
    expect(META_AGENT_GUIDE).toContain(
      'Only the coordinator holding the live claim can transition the task.',
    );
    expect(META_AGENT_GUIDE).toContain('The server liveness finalizer owns');
    expect(META_AGENT_GUIDE).toContain('block and claim release after bound exhaustion or expiry.');
    expect(META_AGENT_GUIDE).toContain('The worker has a different session ID and must not call');
    expect(META_AGENT_GUIDE).toContain('`kortix tasks done` or');
    expect(META_AGENT_GUIDE).toContain('`kortix tasks block` for the coordinator claim.');
    expect(META_AGENT_GUIDE).toContain(
      'kortix tasks done "$TASK_ID" --session "$COORDINATOR_SESSION_ID"',
    );
    expect(META_AGENT_GUIDE).toContain(
      'kortix tasks block "$TASK_ID" --session "$COORDINATOR_SESSION_ID"',
    );
  });

  test('requires an explicit transition and external verifier evidence', () => {
    expect(META_AGENT_GUIDE).toContain('An empty new session');
    expect(META_AGENT_GUIDE).toContain('is awaiting initial-prompt delivery and is not settled or no-progress.');
    expect(META_AGENT_GUIDE).toContain('Exit 0 means settled only.');
    expect(META_AGENT_GUIDE).toContain('never means the task or goal is complete.');
    expect(META_AGENT_GUIDE).toContain('independently verify the resulting external state.');
    expect(META_AGENT_GUIDE).toContain('coordinator then transitions its claim to `done`');
    expect(META_AGENT_GUIDE).toContain('with cited verifier evidence');
    expect(META_AGENT_GUIDE).toContain('`kortix tasks progress` and its evidence ref');
    expect(META_AGENT_GUIDE).toContain('Completion exists only after the explicit durable');
    expect(META_AGENT_GUIDE).toContain('`done` transition plus evidence.');
    expect(META_AGENT_GUIDE).toContain('Record the goal observation with its');
    expect(META_AGENT_GUIDE).toContain('source; use the worker session ID');
  });

  test('uses one idempotent no-progress settlement before server-owned escalation', () => {
    expect(META_AGENT_GUIDE).toContain('`kortix tasks no-progress` with a stable');
    expect(META_AGENT_GUIDE).toContain('Retry the same settlement ID after any timeout or restart.');
    expect(META_AGENT_GUIDE).toContain('queues the only continuation to the same worker');
    expect(META_AGENT_GUIDE).toContain('queues server-owned worker stop');
    expect(META_AGENT_GUIDE).toContain('wakes the coordinator for');
    expect(META_AGENT_GUIDE).toContain('`last_no_progress_settlement_id`');
    expect(META_AGENT_GUIDE).toContain('`last_no_progress_action`');
    expect(META_AGENT_GUIDE).toContain('`last_no_progress_command_id`');
    expect(META_AGENT_GUIDE).toContain('Alternative only when settled without evidence');
    expect(META_AGENT_GUIDE).toContain('Never revive a worker stopped by liveness exhaustion or blocking.');
  });

  test('classifies unmeasurable and stalled goals before selecting work', () => {
    expect(META_AGENT_GUIDE).toContain(
      'A declared metric with no observation is `unmeasurable`, never `on_track`.',
    );
    expect(META_AGENT_GUIDE).toContain(
      'Three consecutive goal-push observations with the same value are `stalled`.',
    );
    expect(META_AGENT_GUIDE).toContain(
      'create a bounded measurement or diagnosis task instead of claiming progress.',
    );
  });

  test('delivers missing secrets and capabilities as blockers without adding a scheduler', () => {
    expect(META_AGENT_GUIDE).toContain(
      'Missing API keys, secrets, approvals, connectors, tools, or capabilities are delivered blockers.',
    );
    expect(META_AGENT_GUIDE).toContain('Never convert one into terminal goal');
    expect(META_AGENT_GUIDE).toContain('rely on the existing');
    expect(META_AGENT_GUIDE).toContain('goal trigger to wake and recheck.');
    expect(META_AGENT_GUIDE).toContain(
      'Never create a second scheduler, heartbeat, wake queue, or self-polling loop.',
    );
  });

  test('continues until reviewed Git status cites external evidence', () => {
    expect(META_AGENT_GUIDE).toContain(
      'Goal pushes stop only after `kortix goals` reads an explicit Git status of `achieved`, `paused`, or `abandoned`',
    );
    expect(META_AGENT_GUIDE).toContain('with cited external evidence.');
    expect(META_AGENT_GUIDE).toContain('immediately recover state and choose');
    expect(META_AGENT_GUIDE).toContain('the next ready task while work exists.');
  });

  test('defines state ownership and meta Git restrictions', () => {
    expect(META_AGENT_GUIDE).toContain(
      'Git owns authored goals, status, policy, code, and durable facts.',
    );
    expect(META_AGENT_GUIDE).toContain('PostgreSQL');
    expect(META_AGENT_GUIDE).toContain(
      'owns contended tasks, claims, transitions, and metric observations.',
    );
    expect(META_AGENT_GUIDE).toContain('This sandbox owns');
    expect(META_AGENT_GUIDE).toContain('disposable scratch state only');
    expect(META_AGENT_GUIDE).toContain('cannot push any branch or merge a change request (CR).');
    expect(META_AGENT_GUIDE).toContain(
      'durable residue on its branch, pushes that branch, and opens a CR.',
    );
  });

  test('contains discoverable goal, task, observation, and session command vocabulary', () => {
    expect(META_AGENT_GUIDE).toContain('kortix goals --help');
    expect(META_AGENT_GUIDE).toContain('kortix tasks --help');
    expect(META_AGENT_GUIDE).toContain('kortix goals ls --json');
    expect(META_AGENT_GUIDE).toContain('kortix goals show "$GOAL_SLUG" --json');
    expect(META_AGENT_GUIDE).toContain(
      'kortix goals observations "$GOAL_SLUG" --metric "$METRIC" --json',
    );
    expect(META_AGENT_GUIDE).toContain(
      'kortix tasks claim "$TASK_ID" --session "$COORDINATOR_SESSION_ID" --json',
    );
    expect(META_AGENT_GUIDE).toContain('kortix tasks done "$TASK_ID"');
    expect(META_AGENT_GUIDE).toContain('kortix tasks block "$TASK_ID"');
    expect(META_AGENT_GUIDE).toContain('kortix goals observe "$GOAL_SLUG"');
    expect(META_AGENT_GUIDE).toContain(
      'kortix sessions wait-for "$WORKER_SESSION_ID" --timeout 120',
    );
  });
});

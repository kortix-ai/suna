import { describe, expect, test } from 'bun:test';

import { AGI_AGENT_GUIDE, buildAgiSandboxDockerfile } from '../agi-dockerfile';

describe('buildAgiSandboxDockerfile', () => {
  test('contains only the platform coordination runtime', () => {
    const dockerfile = buildAgiSandboxDockerfile({
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
    expect(dockerfile).toContain('# Kortix AGI');
    expect(dockerfile).toContain(
      'You own durable tasks. You coordinate workers and verify their results.',
    );
    expect(dockerfile).toContain(
      'Optionally use `kortix sessions cp` after empty session creation',
    );
    expect(dockerfile).toContain('Pass initial work only through `kortix tasks worker --prompt`');
    expect(dockerfile).toContain('never starts another session.');
    expect(dockerfile).toContain(
      'Specialized sessions have full project sandboxes with Python (via `uv` — use `uv run`/`uvx`/`uv pip`,',
    );
    expect(dockerfile).toContain('Read the `kortix-cli` skill first.');
    expect(dockerfile).not.toContain('kortix-rlm');
    expect(dockerfile).not.toContain('KORTIX_HOST_BRIDGE');
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
    expect(dockerfile).not.toContain('ipython');
    expect(dockerfile).not.toContain('/opt/kortix/rlm');
    expect(dockerfile).not.toContain('libreoffice');
    expect(dockerfile).not.toContain('ffmpeg');
    expect(dockerfile).not.toContain('claude-agent-acp');
    expect(dockerfile).not.toContain('codex-acp');
    expect(dockerfile).not.toContain('pi-acp');
    expect(dockerfile).not.toContain('pi-coding-agent');
  });
});

describe('AGI_AGENT_GUIDE control loop', () => {
  test('is task-first and uses the typed blocker reminder contract', () => {
    expect(AGI_AGENT_GUIDE).toContain('Start with the task assigned to this coordinator session.');
    expect(AGI_AGENT_GUIDE.indexOf('kortix tasks current --json')).toBeLessThan(
      AGI_AGENT_GUIDE.indexOf('kortix goals show'),
    );
    expect(AGI_AGENT_GUIDE).toContain('Only load goal state when the task has an owning goal.');
    expect(AGI_AGENT_GUIDE).toContain('kortix tasks blocker "$TASK_ID"');
    expect(AGI_AGENT_GUIDE).toContain('--category "$BLOCKER_CATEGORY"');
    expect(AGI_AGENT_GUIDE).toContain('--remind-at "$REMIND_AT"');
    expect(AGI_AGENT_GUIDE).not.toContain('kortix tasks block "$TASK_ID"');
  });

  test('recovers authoritative state and claims exactly one ready task', () => {
    expect(AGI_AGENT_GUIDE).toContain('Run `kortix tasks current --json`.');
    expect(AGI_AGENT_GUIDE).toContain(
      'list ready tasks with `kortix tasks ls --status todo --json`',
    );
    expect(AGI_AGENT_GUIDE).toContain('atomically claim exactly one task');
    expect(AGI_AGENT_GUIDE).toContain('Hold at most one task claim');
    expect(AGI_AGENT_GUIDE).toContain('one worker session at a time.');
    expect(AGI_AGENT_GUIDE).toContain('Never reconstruct task state from chat or sandbox files.');
  });

  test('creates an empty worker then atomically binds bounds and prompt', () => {
    expect(AGI_AGENT_GUIDE).toContain('`kortix sessions new --json` and no prompt');
    expect(AGI_AGENT_GUIDE).toContain('Then call `kortix tasks worker`');
    expect(AGI_AGENT_GUIDE).toContain('immutable wall/token/cost/iteration');
    expect(AGI_AGENT_GUIDE).toContain('atomically binds the worker and durably queues its prompt');
    expect(AGI_AGENT_GUIDE).toContain('Never send the initial prompt separately.');
    expect(AGI_AGENT_GUIDE).toContain('never starts another session.');
  });

  test('requires an explicit transition and external verifier evidence', () => {
    expect(AGI_AGENT_GUIDE).toContain('An empty new session');
    expect(AGI_AGENT_GUIDE).toContain(
      'is awaiting initial-prompt delivery and is not settled or no-progress.',
    );
    expect(AGI_AGENT_GUIDE).toContain('Exit 0 means settled only.');
    expect(AGI_AGENT_GUIDE).toContain('never means the task is complete.');
    expect(AGI_AGENT_GUIDE).toContain('independently verify the resulting external state.');
    expect(AGI_AGENT_GUIDE).toContain('Add immutable evidence for the current contract revision');
    expect(AGI_AGENT_GUIDE).toContain('Then call `kortix tasks submit`');
    expect(AGI_AGENT_GUIDE).toContain(
      'exactly one of `kortix tasks progress` or `kortix tasks no-progress`',
    );
    expect(AGI_AGENT_GUIDE).toContain('only the server completion gate can mark the task `done`.');
  });

  test('uses one idempotent no-progress settlement before server-owned escalation', () => {
    expect(AGI_AGENT_GUIDE).toContain('`kortix tasks no-progress` with a stable');
    expect(AGI_AGENT_GUIDE).toContain(
      'Retry the same settlement ID after any timeout or restart.',
    );
    expect(AGI_AGENT_GUIDE).toContain('queues the only continuation to the same worker');
    expect(AGI_AGENT_GUIDE).toContain(
      'lets the server finalize liveness and wakes the coordinator',
    );
    expect(AGI_AGENT_GUIDE).toContain('`last_no_progress_settlement_id`');
    expect(AGI_AGENT_GUIDE).toContain('`last_no_progress_action`');
    expect(AGI_AGENT_GUIDE).toContain('`last_no_progress_command_id`');
    expect(AGI_AGENT_GUIDE).toContain('Alternative only when settled without evidence');
    expect(AGI_AGENT_GUIDE).toContain('Never revive a worker stopped by liveness exhaustion.');
  });

  test('classifies unmeasurable and stalled goals before selecting work', () => {
    expect(AGI_AGENT_GUIDE).toContain(
      'A declared metric with no observation is `unmeasurable`, never `on_track`.',
    );
    expect(AGI_AGENT_GUIDE).toContain('goal-push observations with the same value are `stalled`.');
    expect(AGI_AGENT_GUIDE).toContain('Create a bounded measurement or diagnosis task');
  });

  test('delivers missing secrets and capabilities as blockers without adding a scheduler', () => {
    expect(AGI_AGENT_GUIDE).toContain(
      'Missing API keys, secrets, approvals, connectors, tools, or capabilities are delivered blockers.',
    );
    expect(AGI_AGENT_GUIDE).toContain('rely on the existing');
    expect(AGI_AGENT_GUIDE).toContain('task reminder or trigger.');
    expect(AGI_AGENT_GUIDE).toContain('Never create a second scheduler, heartbeat,');
    expect(AGI_AGENT_GUIDE).toContain('wake queue, or self-polling loop.');
  });

  test('loads and updates goals only when the task owns one', () => {
    expect(AGI_AGENT_GUIDE).toContain(
      'A task without `goal_slug` remains fully valid and executable.',
    );
    expect(AGI_AGENT_GUIDE).toContain(
      'Goal pushes stop only after reviewed Git status reads `achieved`, `paused`, or `abandoned`',
    );
    expect(AGI_AGENT_GUIDE).toContain('with cited external evidence.');
    expect(AGI_AGENT_GUIDE).toContain('A task without an owning goal skips all goal commands.');
  });

  test('defines state ownership and AGI Git restrictions', () => {
    expect(AGI_AGENT_GUIDE).toContain(
      'PostgreSQL, accessed through the `kortix` CLI, owns tasks, contracts, claims, blockers, reminders, evidence,',
    );
    expect(AGI_AGENT_GUIDE).toContain(
      'optional goal definitions. This sandbox owns disposable scratch state only.',
    );
    expect(AGI_AGENT_GUIDE).toContain('cannot push any branch or merge a change request (CR).');
    expect(AGI_AGENT_GUIDE).toContain(
      'durable residue on its branch, pushes that branch, and opens a CR.',
    );
  });

  test('contains discoverable goal, task, observation, and session command vocabulary', () => {
    expect(AGI_AGENT_GUIDE).toContain('kortix goals --help');
    expect(AGI_AGENT_GUIDE).toContain('kortix tasks --help');
    expect(AGI_AGENT_GUIDE).not.toContain('kortix-rlm');
    expect(AGI_AGENT_GUIDE).toContain('kortix tasks current --json');
    expect(AGI_AGENT_GUIDE).toContain('kortix goals show "$GOAL_SLUG" --json');
    expect(AGI_AGENT_GUIDE).toContain(
      'kortix goals observations "$GOAL_SLUG" --metric "$METRIC" --json',
    );
    expect(AGI_AGENT_GUIDE).toContain(
      'kortix tasks claim "$TASK_ID" --session "$COORDINATOR_SESSION_ID" --json',
    );
    expect(AGI_AGENT_GUIDE).toContain('kortix tasks submit "$TASK_ID"');
    expect(AGI_AGENT_GUIDE).toContain('kortix tasks blocker "$TASK_ID"');
    expect(AGI_AGENT_GUIDE).toContain('kortix goals observe "$GOAL_SLUG"');
    expect(AGI_AGENT_GUIDE).toContain(
      'kortix sessions wait-for "$WORKER_SESSION_ID" --timeout 120',
    );
  });
});

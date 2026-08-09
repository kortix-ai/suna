import type { CreatableProjectTaskStatus, ProjectTask, ProjectTaskStatus } from '@kortix/sdk';
import { AGI_AGENT_NAME } from '@kortix/shared';

import { kortixFromAuth } from '../api/sdk.ts';
import {
  emitJson,
  resolveProjectContext,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
} from '../command-helpers.ts';
import { C, help, pad, status } from '../style.ts';

const TASK_STATUSES: readonly ProjectTaskStatus[] = [
  'backlog',
  'todo',
  'doing',
  'blocked',
  'review',
  'done',
  'cancelled',
];

const TASK_WORKER_PLATFORM_CEILINGS = {
  max_wall_seconds: 3_600,
  max_tokens: 1_000_000,
  max_cost_usd: 25,
  max_iterations: 128,
} as const;

const CREATABLE_TASK_STATUSES: readonly CreatableProjectTaskStatus[] = ['backlog', 'todo'];

const HELP = help`Usage: kortix tasks <subcommand> [options]

Inspect and update the project's durable autonomous task queue. Claim, done,
and block require the session performing the transition.

Subcommands:
  ls                     List tasks. Supports --goal, --status, --limit, --json.
  show <id>              Show one task. Supports --json.
  current                Show the task bound to this session principal.
  new                    Create a task. Requires --title. --goal is optional.
  claim <id>             Claim a task for a session.
  done <id>              Complete a historical task with cited evidence.
  block <id>             Block a task with a reason.
  worker <id>            Bind bounded worker and deliver its initial prompt.
  progress <id>          Record semantic worker progress.
  no-progress <id>       Atomically continue once, then block and escalate.
  run <id>               Create, claim, and prompt a cloud coordinator session.
  watch <id>             Poll durable task state until it becomes terminal.
  contract <id>          Revise the human-owned outcome and verification contract.
  evidence <id>          Add immutable evidence. Use --list to read evidence.
  submit <id>            Request server-gated completion for one candidate.
  blockers <id>          List open and historical blockers.
  blocker <id>           Create an idempotent typed blocker and reminder.
  resolve-blocker <id>   Resolve a blocker as a human caller.
  events <id>            Show the append-only task event timeline.
  sessions <id>          Show the coordinator, worker, and verifier lineage.
  cancel <id>            Cancel task responsibility as a human caller.

List options:
  --goal <slug>          Only tasks for one goal.
  --status <status>      backlog|todo|doing|blocked|review|done|cancelled.
  --limit <n>            Return 1 to 1000 tasks.

New options:
  --goal <slug>          Optional owning goal.
  --title <text>         Task title (required).
  --body <text>          Task details.
  --priority <integer>   Queue priority.
  --status <status>      backlog|todo (default: backlog).
  --agent <name>         Assign an agent.
  --blocked-by <ids>     Comma-separated task ids.
  --origin <text>        Creation source (default: cli).
  --fingerprint <text>   Idempotency fingerprint for this origin.

Transition options:
  claim: --session <id> [--lease-seconds <30..86400>]
  run:   [--agent <name>] [--lease-seconds <30..86400>] [--prompt <text>]
         Deletes partial sessions and releases an unused claim when launch fails.
  done:  --session <id> --evidence <ref> [--summary <text>]
  block: --session <id> --reason <text>
  worker: --session <claim-id> --worker-session <id> --prompt <text>
          --max-wall-seconds <1..3600> --max-tokens <1..1000000>
          --max-cost-usd <0..25> --max-iterations <1..128>
  progress: --session <claim-id> --worker-session <id> --settlement-id <turn-id> --ref <evidence-ref>
            Use the current task.liveness_turn_id returned by the server.
  no-progress: --session <claim-id> --worker-session <id> --settlement-id <id> --reason <text>

Global options:
  --project <id>         Operate on this project id (default: linked/default).
  --host <name>          Use a configured Kortix host.
  --json                 Print the raw SDK response.
  -h, --help             Show this help.

Examples:
  kortix tasks ls --goal improve-reliability --status todo
  kortix tasks new --title "Add retry telemetry" --status todo
  kortix tasks claim <id> --session <session-id> --lease-seconds 900
  kortix tasks evidence <id> --kind command --ref command:test --candidate sha256:abc --state passed
  kortix tasks submit <id> --session <session-id> --candidate sha256:abc
  kortix tasks worker <id> --session <claim-id> --worker-session <worker-id> \
    --prompt "Implement and verify" --max-wall-seconds 900 --max-tokens 1000000 \
    --max-cost-usd 2.5 --max-iterations 64
  kortix tasks no-progress <id> --session <claim-id> --worker-session <worker-id> \
    --settlement-id <task.liveness_turn_id> --reason "Settled without evidence"
`;

type SdkFactory = typeof kortixFromAuth;

export interface TasksCommandDeps {
  kortixFromAuth?: SdkFactory;
}

interface CommonFlags {
  json: boolean;
  project?: string;
  host?: string;
}

type TaskRunCompensationResult = { status: 'succeeded' } | { status: 'failed'; error: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function compensateTaskRun(
  action: () => Promise<unknown>,
): Promise<TaskRunCompensationResult> {
  try {
    await action();
    return { status: 'succeeded' };
  } catch (error) {
    return { status: 'failed', error: errorMessage(error) };
  }
}

function reportTaskRunCompensation(report: Record<string, unknown>): void {
  process.stderr.write(`Task run compensation: ${JSON.stringify(report)}\n`);
}

function parseCommon(argv: string[]): CommonFlags {
  return {
    json: takeFlagBool(argv, ['--json']),
    project: takeFlagValue(argv, ['--project']),
    host: takeFlagValue(argv, ['--host']),
  };
}

function takeNumericFlag(argv: string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === name) {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${name} requires a value`);
      argv.splice(i, 2);
      return value;
    }
    if (arg.startsWith(`${name}=`)) {
      const value = arg.slice(name.length + 1);
      if (!value) throw new Error(`${name} requires a value`);
      argv.splice(i, 1);
      return value;
    }
  }
  return undefined;
}

function requireText(value: string | undefined, flag: string): string {
  if (!value?.trim()) throw new Error(`${flag} is required`);
  return value.trim();
}

function requireId(argv: string[], action: string): string {
  const id = argv.shift();
  if (!id || id.startsWith('-')) {
    throw new Error(`Pass a task id: kortix tasks ${action} <id>`);
  }
  return id;
}

function rejectExtraArgs(argv: string[]): void {
  if (argv.length === 0) return;
  const arg = argv[0];
  if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
  throw new Error(`Unexpected argument: ${arg}`);
}

function parseInteger(
  raw: string | undefined,
  flag: string,
  bounds?: { min: number; max: number },
): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^-?\d+$/.test(raw)) throw new Error(`${flag} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${flag} must be a safe integer`);
  if (bounds && (value < bounds.min || value > bounds.max)) {
    throw new Error(`${flag} must be between ${bounds.min} and ${bounds.max}`);
  }
  return value;
}

function requirePositiveInteger(raw: string | undefined, flag: string, max?: number): number {
  const value = parseInteger(raw, flag);
  if (value === undefined || value <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  if (max !== undefined && value > max) {
    throw new Error(`${flag} must be between 1 and ${max}`);
  }
  return value;
}

function requirePositiveNumber(raw: string | undefined, flag: string, max?: number): number {
  if (raw === undefined) throw new Error(`${flag} is required`);
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${flag} must be a positive finite number`);
  }
  if (max !== undefined && value > max) {
    throw new Error(`${flag} must be between 0 (exclusive) and ${max}`);
  }
  return value;
}

function parseStatus(raw: string | undefined): ProjectTaskStatus | undefined {
  if (raw === undefined) return undefined;
  if (!TASK_STATUSES.includes(raw as ProjectTaskStatus)) {
    throw new Error(`--status must be one of: ${TASK_STATUSES.join(', ')}`);
  }
  return raw as ProjectTaskStatus;
}

function parseCreatableStatus(raw: string | undefined): CreatableProjectTaskStatus | undefined {
  if (raw === undefined) return undefined;
  if (!CREATABLE_TASK_STATUSES.includes(raw as CreatableProjectTaskStatus)) {
    throw new Error(
      `--status creatable status must be one of: ${CREATABLE_TASK_STATUSES.join(', ')}`,
    );
  }
  return raw as CreatableProjectTaskStatus;
}

function parseBlockedBy(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const ids = raw.split(',').map((id) => id.trim());
  if (ids.length === 0 || ids.some((id) => !id)) {
    throw new Error('--blocked-by must be a comma-separated list of task ids');
  }
  return ids;
}

function parseCsv(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const values = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length === 0) throw new Error('The comma-separated value cannot be empty');
  return values;
}

function parseJsonRecord(
  raw: string | undefined,
  flag: string,
): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  const value = JSON.parse(raw) as unknown;
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new Error(`${flag} must contain a JSON object`);
  }
  return value as Record<string, unknown>;
}

function optionalIso(raw: string | undefined, flag: string): string | undefined {
  if (raw === undefined) return undefined;
  if (!raw.trim() || Number.isNaN(Date.parse(raw)))
    throw new Error(`${flag} must be an ISO timestamp`);
  return new Date(raw).toISOString();
}

async function projectHandle(flags: CommonFlags, sdkFactory: SdkFactory) {
  const ctx = await resolveProjectContext({
    projectArg: flags.project,
    hostArg: flags.host,
  });
  if (!ctx) return null;
  return sdkFactory(ctx.auth).project(ctx.projectId);
}

export async function runTasks(argv: string[], deps: TasksCommandDeps = {}): Promise<number> {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(HELP);
    return argv.length === 0 ? 2 : 0;
  }
  if (argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(HELP);
    return 0;
  }

  const subcommand = argv[0];
  const rest = argv.slice(1);
  const sdkFactory = deps.kortixFromAuth ?? kortixFromAuth;

  try {
    const flags = parseCommon(rest);
    switch (subcommand) {
      case 'current': {
        rejectExtraArgs(rest);
        const project = await projectHandle(flags, sdkFactory);
        if (!project) return 1;
        try {
          const response = await project.tasks.current();
          if (flags.json) emitJson(response);
          else renderTask(response.task);
          return 0;
        } catch (error) {
          return surfaceApiError(error);
        }
      }
      case 'ls':
      case 'list': {
        const goal = takeFlagValue(rest, ['--goal']);
        const taskStatus = parseStatus(takeFlagValue(rest, ['--status']));
        const limit = parseInteger(takeNumericFlag(rest, '--limit'), '--limit', {
          min: 1,
          max: 1_000,
        });
        rejectExtraArgs(rest);

        const project = await projectHandle(flags, sdkFactory);
        if (!project) return 1;
        try {
          const response = await project.tasks.list({
            ...(goal === undefined ? {} : { goal_slug: goal }),
            ...(taskStatus === undefined ? {} : { statuses: [taskStatus] }),
            ...(limit === undefined ? {} : { limit }),
          });
          if (flags.json) emitJson(response);
          else renderTaskList(response.tasks);
          return 0;
        } catch (error) {
          return surfaceApiError(error);
        }
      }
      case 'show': {
        const id = requireId(rest, 'show');
        rejectExtraArgs(rest);
        const project = await projectHandle(flags, sdkFactory);
        if (!project) return 1;
        try {
          const response = await project.tasks.get(id);
          if (flags.json) emitJson(response);
          else renderTask(response.task);
          return 0;
        } catch (error) {
          return surfaceApiError(error);
        }
      }
      case 'new':
      case 'create': {
        const rawGoal = takeFlagValue(rest, ['--goal']);
        const goal = rawGoal === undefined ? undefined : requireText(rawGoal, '--goal');
        const title = requireText(takeFlagValue(rest, ['--title']), '--title');
        const body = takeFlagValue(rest, ['--body']);
        const priority = parseInteger(takeNumericFlag(rest, '--priority'), '--priority');
        const taskStatus = parseCreatableStatus(takeFlagValue(rest, ['--status']));
        const agent = takeFlagValue(rest, ['--agent']);
        const blockedBy = parseBlockedBy(takeFlagValue(rest, ['--blocked-by']));
        const origin = (takeFlagValue(rest, ['--origin']) ?? 'cli').trim();
        const fingerprint = takeFlagValue(rest, ['--fingerprint']);
        rejectExtraArgs(rest);

        if (!origin) throw new Error('--origin cannot be empty');
        if (agent !== undefined && !agent.trim()) throw new Error('--agent cannot be empty');
        if (fingerprint !== undefined && !fingerprint.trim()) {
          throw new Error('--fingerprint cannot be empty');
        }

        const project = await projectHandle(flags, sdkFactory);
        if (!project) return 1;
        try {
          const response = await project.tasks.create({
            title,
            origin,
            ...(goal === undefined ? {} : { goal_slug: goal }),
            ...(body === undefined ? {} : { body }),
            ...(priority === undefined ? {} : { priority }),
            ...(taskStatus === undefined ? {} : { status: taskStatus }),
            ...(agent === undefined ? {} : { assignee_agent: agent.trim() }),
            ...(blockedBy === undefined ? {} : { blocked_by: blockedBy }),
            ...(fingerprint === undefined ? {} : { origin_fingerprint: fingerprint.trim() }),
          });
          if (flags.json) emitJson(response);
          else {
            const verb = response.created ? 'Created' : 'Reused';
            process.stdout.write(
              `${status.ok(`${verb} task ${response.task.task_id}: ${response.task.title}`)}\n`,
            );
          }
          return 0;
        } catch (error) {
          return surfaceApiError(error);
        }
      }
      case 'claim': {
        const id = requireId(rest, 'claim');
        const session = requireText(takeFlagValue(rest, ['--session']), '--session');
        const leaseSeconds = parseInteger(
          takeNumericFlag(rest, '--lease-seconds'),
          '--lease-seconds',
          { min: 30, max: 86_400 },
        );
        rejectExtraArgs(rest);

        const project = await projectHandle(flags, sdkFactory);
        if (!project) return 1;
        try {
          const response = await project.tasks.claim(id, {
            session_id: session,
            ...(leaseSeconds === undefined ? {} : { lease_seconds: leaseSeconds }),
          });
          if (flags.json) emitJson(response);
          else {
            const until = response.task.claim_expires_at
              ? ` until ${response.task.claim_expires_at}`
              : '';
            process.stdout.write(`${status.ok(`Claimed task ${id} for ${session}${until}`)}\n`);
          }
          return 0;
        } catch (error) {
          return surfaceApiError(error);
        }
      }
      case 'run': {
        const id = requireId(rest, 'run');
        const agent = (takeFlagValue(rest, ['--agent']) ?? AGI_AGENT_NAME).trim();
        const leaseSeconds = parseInteger(
          takeNumericFlag(rest, '--lease-seconds') ?? '3600',
          '--lease-seconds',
          { min: 30, max: 86_400 },
        );
        const customPrompt = takeFlagValue(rest, ['--prompt']);
        rejectExtraArgs(rest);
        if (!agent) throw new Error('--agent cannot be empty');
        const project = await projectHandle(flags, sdkFactory);
        if (!project) return 1;
        let session: Awaited<ReturnType<typeof project.sessions.create>> | undefined;
        let stage: 'create' | 'claim' | 'prompt' = 'create';
        let compensatedError: unknown;
        try {
          session = await project.sessions.create({
            agent_name: agent,
            name: `Task ${id}`,
            metadata: { task_id: id, task_role: 'coordinator' },
          });
          stage = 'claim';
          const claimed = await project.tasks.claim(id, {
            session_id: session.session_id,
            lease_seconds: leaseSeconds,
          });
          const prompt =
            customPrompt?.trim() ||
            [
              `You own durable Kortix task ${id}.`,
              'Read the current task contract, blockers, evidence, events, and session lineage before acting.',
              'Delegate bounded work when useful. Record immutable evidence against the current contract revision.',
              'Use typed blockers only after you verified that human action is required.',
              'Do not stop until the server accepts completion or the task has a durable blocker and reminder.',
            ].join(' ');
          stage = 'prompt';
          await project.session(session.session_id).send(prompt, { agent });
          const response = { session, task: claimed.task };
          if (flags.json) emitJson(response);
          else
            process.stdout.write(
              `${status.ok(`Running task ${id} in session ${session.session_id}`)}\n`,
            );
          return 0;
        } catch (error) {
          if (!session || stage === 'create') return surfaceApiError(error);
          const sessionId = session.session_id;
          const handle = project.session(sessionId);
          if (stage === 'claim') {
            const sessionDelete = await compensateTaskRun(() => handle.delete());
            reportTaskRunCompensation({
              stage,
              session_id: sessionId,
              session_delete: sessionDelete,
            });
          } else {
            const sessionStop = await compensateTaskRun(() => handle.stop());
            const sessionDelete = await compensateTaskRun(() => handle.delete());
            const taskClaimRelease = await compensateTaskRun(() =>
              project.tasks.releaseClaim(id, { session_id: sessionId }),
            );
            reportTaskRunCompensation({
              stage,
              session_id: sessionId,
              session_stop: sessionStop,
              session_delete: sessionDelete,
              task_claim_release: taskClaimRelease,
            });
          }
          compensatedError = error;
        }
        return surfaceApiError(compensatedError);
      }
      case 'watch': {
        const id = requireId(rest, 'watch');
        const once = takeFlagBool(rest, ['--once']);
        const intervalSeconds = parseInteger(
          takeNumericFlag(rest, '--interval-seconds') ?? '5',
          '--interval-seconds',
          { min: 1, max: 3_600 },
        ) as number;
        const timeoutSeconds = parseInteger(
          takeNumericFlag(rest, '--timeout-seconds'),
          '--timeout-seconds',
          { min: 1, max: 604_800 },
        );
        rejectExtraArgs(rest);
        const project = await projectHandle(flags, sdkFactory);
        if (!project) return 1;
        const startedAt = Date.now();
        try {
          while (true) {
            const response = await project.tasks.get(id);
            if (flags.json) emitJson(response);
            else
              process.stdout.write(
                `${response.task.updated_at} ${response.task.status} ${response.task.task_id}\n`,
              );
            if (once || response.task.status === 'done' || response.task.status === 'cancelled')
              return 0;
            if (timeoutSeconds !== undefined && Date.now() - startedAt >= timeoutSeconds * 1_000) {
              process.stderr.write(`${status.err(`Timed out waiting for task ${id}`)}\n`);
              return 1;
            }
            await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1_000));
          }
        } catch (error) {
          return surfaceApiError(error);
        }
        return 1;
      }
      case 'done': {
        const id = requireId(rest, 'done');
        const session = requireText(takeFlagValue(rest, ['--session']), '--session');
        const evidence = requireText(takeFlagValue(rest, ['--evidence']), '--evidence');
        const summary = takeFlagValue(rest, ['--summary']);
        rejectExtraArgs(rest);
        if (summary !== undefined && !summary.trim()) throw new Error('--summary cannot be empty');

        const project = await projectHandle(flags, sdkFactory);
        if (!project) return 1;
        try {
          const response = await project.tasks.complete(id, {
            session_id: session,
            evidence: [
              {
                ref: evidence,
                ...(summary === undefined ? {} : { summary: summary.trim() }),
              },
            ],
          });
          if (flags.json) emitJson(response);
          else process.stdout.write(`${status.ok(`Completed task ${response.task.task_id}`)}\n`);
          return 0;
        } catch (error) {
          return surfaceApiError(error);
        }
      }
      case 'block': {
        const id = requireId(rest, 'block');
        const session = requireText(takeFlagValue(rest, ['--session']), '--session');
        const reason = requireText(takeFlagValue(rest, ['--reason']), '--reason');
        rejectExtraArgs(rest);

        const project = await projectHandle(flags, sdkFactory);
        if (!project) return 1;
        try {
          const response = await project.tasks.block(id, {
            session_id: session,
            blocker: reason,
          });
          if (flags.json) emitJson(response);
          else
            process.stdout.write(
              `${status.ok(`Blocked task ${response.task.task_id}: ${reason}`)}\n`,
            );
          return 0;
        } catch (error) {
          return surfaceApiError(error);
        }
      }
      case 'worker': {
        const id = requireId(rest, 'worker');
        const session = requireText(takeFlagValue(rest, ['--session']), '--session');
        const workerSession = requireText(
          takeFlagValue(rest, ['--worker-session']),
          '--worker-session',
        );
        const prompt = requireText(takeFlagValue(rest, ['--prompt']), '--prompt');
        const maxWallSeconds = requirePositiveInteger(
          takeNumericFlag(rest, '--max-wall-seconds'),
          '--max-wall-seconds',
          TASK_WORKER_PLATFORM_CEILINGS.max_wall_seconds,
        );
        const maxTokens = requirePositiveInteger(
          takeNumericFlag(rest, '--max-tokens'),
          '--max-tokens',
          TASK_WORKER_PLATFORM_CEILINGS.max_tokens,
        );
        const maxCostUsd = requirePositiveNumber(
          takeNumericFlag(rest, '--max-cost-usd'),
          '--max-cost-usd',
          TASK_WORKER_PLATFORM_CEILINGS.max_cost_usd,
        );
        const maxIterations = requirePositiveInteger(
          takeNumericFlag(rest, '--max-iterations'),
          '--max-iterations',
          TASK_WORKER_PLATFORM_CEILINGS.max_iterations,
        );
        rejectExtraArgs(rest);
        const project = await projectHandle(flags, sdkFactory);
        if (!project) return 1;
        try {
          const response = await project.tasks.registerWorker(id, {
            session_id: session,
            worker_session_id: workerSession,
            prompt,
            contract: {
              max_wall_seconds: maxWallSeconds,
              max_tokens: maxTokens,
              max_cost_usd: maxCostUsd,
              max_iterations: maxIterations,
            },
          });
          if (flags.json) emitJson(response);
          else
            process.stdout.write(
              `${status.ok(`Worker ${response.worker.state} for task ${response.task.task_id}; turn ${response.task.liveness_turn_id}`)}\n`,
            );
          return 0;
        } catch (error) {
          return surfaceApiError(error);
        }
      }
      case 'progress': {
        const id = requireId(rest, 'progress');
        const session = requireText(takeFlagValue(rest, ['--session']), '--session');
        const workerSession = requireText(
          takeFlagValue(rest, ['--worker-session']),
          '--worker-session',
        );
        const settlementId = requireText(
          takeFlagValue(rest, ['--settlement-id']),
          '--settlement-id',
        );
        const ref = requireText(takeFlagValue(rest, ['--ref']), '--ref');
        rejectExtraArgs(rest);
        const project = await projectHandle(flags, sdkFactory);
        if (!project) return 1;
        try {
          const response = await project.tasks.recordProgress(id, {
            session_id: session,
            worker_session_id: workerSession,
            settlement_id: settlementId,
            ref,
          });
          if (flags.json) emitJson(response);
          else
            process.stdout.write(
              `${status.ok(`Recorded progress for task ${response.task.task_id}; next turn ${response.task.liveness_turn_id}`)}\n`,
            );
          return 0;
        } catch (error) {
          return surfaceApiError(error);
        }
      }
      case 'no-progress': {
        const id = requireId(rest, 'no-progress');
        const session = requireText(takeFlagValue(rest, ['--session']), '--session');
        const workerSession = requireText(
          takeFlagValue(rest, ['--worker-session']),
          '--worker-session',
        );
        const settlementId = requireText(
          takeFlagValue(rest, ['--settlement-id']),
          '--settlement-id',
        );
        const reason = requireText(takeFlagValue(rest, ['--reason']), '--reason');
        rejectExtraArgs(rest);
        const project = await projectHandle(flags, sdkFactory);
        if (!project) return 1;
        try {
          const response = await project.tasks.settleNoProgress(id, {
            session_id: session,
            worker_session_id: workerSession,
            settlement_id: settlementId,
            reason,
          });
          if (flags.json) emitJson(response);
          else {
            const label = response.action === 'continuation_queued' ? 'Continue' : 'Escalate';
            process.stdout.write(`${status.ok(`${label} task ${response.task.task_id}`)}\n`);
          }
          return 0;
        } catch (error) {
          return surfaceApiError(error);
        }
      }
      case 'contract': {
        const id = requireId(rest, 'contract');
        const intent = takeFlagValue(rest, ['--intent']);
        const constraints = parseCsv(takeFlagValue(rest, ['--constraints']));
        const outOfScope = parseCsv(takeFlagValue(rest, ['--out-of-scope']));
        const review = takeFlagValue(rest, ['--review']);
        const requirementsRaw = takeFlagValue(rest, ['--requirements-json']);
        if (review !== undefined && review !== 'auto' && review !== 'human') {
          throw new Error('--review must be auto or human');
        }
        let verificationRequirements:
          | Array<{
              id: string;
              kind: 'command' | 'http' | 'artifact' | 'deployment' | 'policy' | 'human' | 'monitor';
              description: string;
              required: boolean;
            }>
          | undefined;
        if (requirementsRaw !== undefined) {
          const parsed = JSON.parse(requirementsRaw) as unknown;
          if (!Array.isArray(parsed))
            throw new Error('--requirements-json must contain a JSON array');
          verificationRequirements = parsed as typeof verificationRequirements;
        }
        rejectExtraArgs(rest);
        if (
          intent === undefined &&
          constraints === undefined &&
          outOfScope === undefined &&
          review === undefined &&
          verificationRequirements === undefined
        )
          throw new Error('Pass at least one task contract field');
        const project = await projectHandle(flags, sdkFactory);
        if (!project) return 1;
        try {
          const response = await project.tasks.reviseContract(id, {
            ...(intent === undefined ? {} : { intent: requireText(intent, '--intent') }),
            ...(constraints === undefined ? {} : { constraints }),
            ...(outOfScope === undefined ? {} : { out_of_scope: outOfScope }),
            ...(review === undefined ? {} : { review_policy: { mode: review } }),
            ...(verificationRequirements === undefined
              ? {}
              : { verification_requirements: verificationRequirements }),
          });
          if (flags.json) emitJson(response);
          else
            process.stdout.write(
              `${status.ok(`Revised task ${id} contract to revision ${response.task.contract_revision}`)}\n`,
            );
          return 0;
        } catch (error) {
          return surfaceApiError(error);
        }
      }
      case 'evidence': {
        const id = requireId(rest, 'evidence');
        const list = takeFlagBool(rest, ['--list']);
        const project = await projectHandle(flags, sdkFactory);
        if (!project) return 1;
        try {
          if (list) {
            rejectExtraArgs(rest);
            const response = await project.tasks.evidence.list(id);
            if (flags.json) emitJson(response);
            else process.stdout.write(`${JSON.stringify(response.evidence, null, 2)}\n`);
            return 0;
          }
          const kind = requireText(takeFlagValue(rest, ['--kind']), '--kind');
          const ref = requireText(takeFlagValue(rest, ['--ref']), '--ref');
          const candidate = requireText(takeFlagValue(rest, ['--candidate']), '--candidate');
          const state = requireText(takeFlagValue(rest, ['--state']), '--state');
          const requirement = takeFlagValue(rest, ['--requirement']);
          const summary = takeFlagValue(rest, ['--summary']);
          if (state !== 'passed' && state !== 'failed' && state !== 'info') {
            throw new Error('--state must be passed, failed, or info');
          }
          rejectExtraArgs(rest);
          const response = await project.tasks.evidence.add(id, {
            kind,
            ref,
            candidate_digest: candidate,
            state,
            ...(requirement === undefined
              ? {}
              : { requirement_id: requireText(requirement, '--requirement') }),
            ...(summary === undefined ? {} : { summary }),
          });
          if (flags.json) emitJson(response);
          else
            process.stdout.write(
              `${status.ok(`Added ${state} evidence ${response.evidence.evidence_id}`)}\n`,
            );
          return 0;
        } catch (error) {
          return surfaceApiError(error);
        }
      }
      case 'submit': {
        const id = requireId(rest, 'submit');
        const candidate = requireText(takeFlagValue(rest, ['--candidate']), '--candidate');
        const session = takeFlagValue(rest, ['--session']);
        rejectExtraArgs(rest);
        const project = await projectHandle(flags, sdkFactory);
        if (!project) return 1;
        try {
          const response = await project.tasks.requestCompletion(id, {
            candidate_digest: candidate,
            ...(session === undefined ? {} : { session_id: requireText(session, '--session') }),
          });
          if (flags.json) emitJson(response);
          else process.stdout.write(`${status.ok(`Verified and completed task ${id}`)}\n`);
          return 0;
        } catch (error) {
          return surfaceApiError(error);
        }
      }
      case 'blockers': {
        const id = requireId(rest, 'blockers');
        rejectExtraArgs(rest);
        const project = await projectHandle(flags, sdkFactory);
        if (!project) return 1;
        try {
          const response = await project.tasks.blockers.list(id);
          if (flags.json) emitJson(response);
          else process.stdout.write(`${JSON.stringify(response.blockers, null, 2)}\n`);
          return 0;
        } catch (error) {
          return surfaceApiError(error);
        }
      }
      case 'blocker': {
        const id = requireId(rest, 'blocker');
        const category = requireText(takeFlagValue(rest, ['--category']), '--category');
        const action = requireText(takeFlagValue(rest, ['--action']), '--action');
        const digest = requireText(takeFlagValue(rest, ['--digest']), '--digest');
        const target = parseJsonRecord(takeFlagValue(rest, ['--target-json']), '--target-json');
        const attempts = parseCsv(takeFlagValue(rest, ['--attempts']));
        const remindAt = optionalIso(takeFlagValue(rest, ['--remind-at']), '--remind-at');
        const expiresAt = optionalIso(takeFlagValue(rest, ['--expires-at']), '--expires-at');
        const session = takeFlagValue(rest, ['--session']);
        rejectExtraArgs(rest);
        const project = await projectHandle(flags, sdkFactory);
        if (!project) return 1;
        try {
          const response = await project.tasks.blockers.create(id, {
            category,
            requested_action: action,
            request_digest: digest,
            ...(target === undefined ? {} : { target }),
            ...(attempts === undefined ? {} : { attempts_made: attempts }),
            ...(remindAt === undefined ? {} : { next_reminder_at: remindAt }),
            ...(expiresAt === undefined ? {} : { expires_at: expiresAt }),
            ...(session === undefined ? {} : { session_id: requireText(session, '--session') }),
          });
          if (flags.json) emitJson(response);
          else
            process.stdout.write(
              `${status.ok(`${response.created ? 'Created' : 'Reused'} blocker ${response.blocker.blocker_id}`)}\n`,
            );
          return 0;
        } catch (error) {
          return surfaceApiError(error);
        }
      }
      case 'resolve-blocker': {
        const id = requireId(rest, 'resolve-blocker');
        const blockerId = requireText(takeFlagValue(rest, ['--blocker']), '--blocker');
        rejectExtraArgs(rest);
        const project = await projectHandle(flags, sdkFactory);
        if (!project) return 1;
        try {
          const response = await project.tasks.blockers.resolve(id, blockerId);
          if (flags.json) emitJson(response);
          else process.stdout.write(`${status.ok(`Resolved blocker ${blockerId}`)}\n`);
          return 0;
        } catch (error) {
          return surfaceApiError(error);
        }
      }
      case 'events': {
        const id = requireId(rest, 'events');
        const limit = parseInteger(takeNumericFlag(rest, '--limit'), '--limit', {
          min: 1,
          max: 1_000,
        });
        rejectExtraArgs(rest);
        const project = await projectHandle(flags, sdkFactory);
        if (!project) return 1;
        try {
          const response = await project.tasks.events(id, limit);
          if (flags.json) emitJson(response);
          else process.stdout.write(`${JSON.stringify(response.events, null, 2)}\n`);
          return 0;
        } catch (error) {
          return surfaceApiError(error);
        }
      }
      case 'sessions': {
        const id = requireId(rest, 'sessions');
        rejectExtraArgs(rest);
        const project = await projectHandle(flags, sdkFactory);
        if (!project) return 1;
        try {
          const response = await project.tasks.sessions(id);
          if (flags.json) emitJson(response);
          else process.stdout.write(`${JSON.stringify(response.sessions, null, 2)}\n`);
          return 0;
        } catch (error) {
          return surfaceApiError(error);
        }
      }
      case 'cancel': {
        const id = requireId(rest, 'cancel');
        const reason = requireText(takeFlagValue(rest, ['--reason']), '--reason');
        rejectExtraArgs(rest);
        const project = await projectHandle(flags, sdkFactory);
        if (!project) return 1;
        try {
          const response = await project.tasks.cancel(id, { reason });
          if (flags.json) emitJson(response);
          else process.stdout.write(`${status.ok(`Canceled task ${id}`)}\n`);
          return 0;
        } catch (error) {
          return surfaceApiError(error);
        }
      }
      default:
        process.stderr.write(
          `${status.err(`Unknown tasks subcommand "${subcommand}"`)}\n\n${HELP}`,
        );
        return 2;
    }
  } catch (error) {
    process.stderr.write(
      `${status.err((error as Error).message)}\n\nRun ${C.cyan}kortix tasks --help${C.reset}.\n`,
    );
    return 2;
  }
}

function taskGoalLabel(task: ProjectTask): string {
  return task.goal_slug ?? 'None';
}

function renderTaskList(tasks: ProjectTask[]): void {
  if (tasks.length === 0) {
    process.stdout.write('No tasks match these filters.\n');
    return;
  }
  const statusWidth = Math.max(6, ...tasks.map((task) => task.status.length));
  const goalWidth = Math.max(4, ...tasks.map((task) => taskGoalLabel(task).length));
  process.stdout.write(
    `${pad('ID', 36)}  ${pad('STATUS', statusWidth)}  PRI  ${pad('GOAL', goalWidth)}  TITLE\n`,
  );
  for (const task of tasks) {
    process.stdout.write(
      `${pad(task.task_id, 36)}  ${pad(task.status, statusWidth)}  ${pad(String(task.priority), 3)}  ${pad(taskGoalLabel(task), goalWidth)}  ${task.title}\n`,
    );
  }
}

function renderTask(task: ProjectTask): void {
  process.stdout.write(`${C.bold}${task.title}${C.reset}\n`);
  process.stdout.write(`ID: ${task.task_id}\n`);
  process.stdout.write(`Goal: ${taskGoalLabel(task)}\n`);
  process.stdout.write(`Status: ${task.status}\n`);
  process.stdout.write(`Priority: ${task.priority}\n`);
  if (task.assignee_agent) process.stdout.write(`Agent: ${task.assignee_agent}\n`);
  if (task.claim_session_id) {
    process.stdout.write(
      `Claim: ${task.claim_session_id}${task.claim_expires_at ? ` until ${task.claim_expires_at}` : ''}\n`,
    );
  }
  if (task.blocked_by.length > 0)
    process.stdout.write(`Blocked by: ${task.blocked_by.join(', ')}\n`);
  if (task.body) process.stdout.write(`\n${task.body}\n`);
  if (Object.keys(task.result).length > 0) {
    process.stdout.write(`Result: ${JSON.stringify(task.result)}\n`);
  }
}

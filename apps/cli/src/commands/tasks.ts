import type {
  CreatableProjectTaskStatus,
  ProjectTask,
  ProjectTaskStatus,
} from "@kortix/sdk";

import {
  emitJson,
  resolveProjectContext,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
} from "../command-helpers.ts";
import { kortixFromAuth } from "../api/sdk.ts";
import { C, help, pad, status } from "../style.ts";

const TASK_STATUSES: readonly ProjectTaskStatus[] = [
  "backlog",
  "todo",
  "doing",
  "blocked",
  "review",
  "done",
  "cancelled",
];

const TASK_WORKER_PLATFORM_CEILINGS = {
  max_wall_seconds: 3_600,
  max_tokens: 1_000_000,
  max_cost_usd: 25,
  max_iterations: 128,
} as const;

const CREATABLE_TASK_STATUSES: readonly CreatableProjectTaskStatus[] = [
  "backlog",
  "todo",
  "doing",
  "review",
  "cancelled",
];

const HELP = help`Usage: kortix tasks <subcommand> [options]

Inspect and update the project's durable autonomous task queue. Claim, done,
and block require the session performing the transition.

Subcommands:
  ls                     List tasks. Supports --goal, --status, --limit, --json.
  show <id>              Show one task. Supports --json.
  new                    Create a task. Requires --goal and --title.
  claim <id>             Claim a task for a session.
  done <id>              Complete a task with cited evidence.
  block <id>             Block a task with a reason.
  worker <id>            Bind bounded worker and deliver its initial prompt.
  progress <id>          Record semantic worker progress.
  no-progress <id>       Atomically continue once, then block and escalate.

List options:
  --goal <slug>          Only tasks for one goal.
  --status <status>      backlog|todo|doing|blocked|review|done|cancelled.
  --limit <n>            Return 1 to 1000 tasks.

New options:
  --goal <slug>          Owning goal (required).
  --title <text>         Task title (required).
  --body <text>          Task details.
  --priority <integer>   Queue priority.
  --status <status>      backlog|todo|doing|review|cancelled (default: backlog).
  --agent <name>         Assign an agent.
  --blocked-by <ids>     Comma-separated task ids.
  --origin <text>        Creation source (default: cli).
  --fingerprint <text>   Idempotency fingerprint for this origin.

Transition options:
  claim: --session <id> [--lease-seconds <30..86400>]
  done:  --session <id> --evidence <ref> [--summary <text>]
  block: --session <id> --reason <text>
  worker: --session <claim-id> --worker-session <id> --prompt <text>
          --max-wall-seconds <1..3600> --max-tokens <1..1000000>
          --max-cost-usd <0..25> --max-iterations <1..128>
  progress: --session <claim-id> --worker-session <id> --ref <evidence-ref>
  no-progress: --session <claim-id> --worker-session <id> --settlement-id <id> --reason <text>

Global options:
  --project <id>         Operate on this project id (default: linked/default).
  --host <name>          Use a configured Kortix host.
  --json                 Print the raw SDK response.
  -h, --help             Show this help.

Examples:
  kortix tasks ls --goal improve-reliability --status todo
  kortix tasks new --goal improve-reliability --title "Add retry telemetry" --status todo
  kortix tasks claim <id> --session <session-id> --lease-seconds 900
  kortix tasks done <id> --session <session-id> --evidence pr:123
  kortix tasks worker <id> --session <claim-id> --worker-session <worker-id> \
    --prompt "Implement and verify" --max-wall-seconds 900 --max-tokens 50000 \
    --max-cost-usd 2.5 --max-iterations 8
  kortix tasks no-progress <id> --session <claim-id> --worker-session <worker-id> \
    --settlement-id turn-1 --reason "Settled without evidence"
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

function parseCommon(argv: string[]): CommonFlags {
  return {
    json: takeFlagBool(argv, ["--json"]),
    project: takeFlagValue(argv, ["--project"]),
    host: takeFlagValue(argv, ["--host"]),
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
  if (!id || id.startsWith("-")) {
    throw new Error(`Pass a task id: kortix tasks ${action} <id>`);
  }
  return id;
}

function rejectExtraArgs(argv: string[]): void {
  if (argv.length === 0) return;
  const arg = argv[0];
  if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
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
  if (!Number.isSafeInteger(value))
    throw new Error(`${flag} must be a safe integer`);
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

function requirePositiveNumber(
  raw: string | undefined,
  flag: string,
  max?: number,
): number {
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
    throw new Error(`--status must be one of: ${TASK_STATUSES.join(", ")}`);
  }
  return raw as ProjectTaskStatus;
}

function parseCreatableStatus(
  raw: string | undefined,
): CreatableProjectTaskStatus | undefined {
  if (raw === undefined) return undefined;
  if (!CREATABLE_TASK_STATUSES.includes(raw as CreatableProjectTaskStatus)) {
    throw new Error(
      `--status creatable status must be one of: ${CREATABLE_TASK_STATUSES.join(", ")}`,
    );
  }
  return raw as CreatableProjectTaskStatus;
}

function parseBlockedBy(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const ids = raw.split(",").map((id) => id.trim());
  if (ids.length === 0 || ids.some((id) => !id)) {
    throw new Error("--blocked-by must be a comma-separated list of task ids");
  }
  return ids;
}

async function projectHandle(flags: CommonFlags, sdkFactory: SdkFactory) {
  const ctx = await resolveProjectContext({
    projectArg: flags.project,
    hostArg: flags.host,
  });
  if (!ctx) return null;
  return sdkFactory(ctx.auth).project(ctx.projectId);
}

export async function runTasks(
  argv: string[],
  deps: TasksCommandDeps = {},
): Promise<number> {
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    process.stdout.write(HELP);
    return argv.length === 0 ? 2 : 0;
  }
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(HELP);
    return 0;
  }

  const subcommand = argv[0];
  const rest = argv.slice(1);
  const sdkFactory = deps.kortixFromAuth ?? kortixFromAuth;

  try {
    const flags = parseCommon(rest);
    switch (subcommand) {
      case "ls":
      case "list": {
        const goal = takeFlagValue(rest, ["--goal"]);
        const taskStatus = parseStatus(takeFlagValue(rest, ["--status"]));
        const limit = parseInteger(
          takeNumericFlag(rest, "--limit"),
          "--limit",
          {
            min: 1,
            max: 1_000,
          },
        );
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
      case "show": {
        const id = requireId(rest, "show");
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
      case "new":
      case "create": {
        const goal = requireText(takeFlagValue(rest, ["--goal"]), "--goal");
        const title = requireText(takeFlagValue(rest, ["--title"]), "--title");
        const body = takeFlagValue(rest, ["--body"]);
        const priority = parseInteger(
          takeNumericFlag(rest, "--priority"),
          "--priority",
        );
        const taskStatus = parseCreatableStatus(
          takeFlagValue(rest, ["--status"]),
        );
        const agent = takeFlagValue(rest, ["--agent"]);
        const blockedBy = parseBlockedBy(takeFlagValue(rest, ["--blocked-by"]));
        const origin = (takeFlagValue(rest, ["--origin"]) ?? "cli").trim();
        const fingerprint = takeFlagValue(rest, ["--fingerprint"]);
        rejectExtraArgs(rest);

        if (!origin) throw new Error("--origin cannot be empty");
        if (agent !== undefined && !agent.trim())
          throw new Error("--agent cannot be empty");
        if (fingerprint !== undefined && !fingerprint.trim()) {
          throw new Error("--fingerprint cannot be empty");
        }

        const project = await projectHandle(flags, sdkFactory);
        if (!project) return 1;
        try {
          const response = await project.tasks.create({
            goal_slug: goal,
            title,
            origin,
            ...(body === undefined ? {} : { body }),
            ...(priority === undefined ? {} : { priority }),
            ...(taskStatus === undefined ? {} : { status: taskStatus }),
            ...(agent === undefined ? {} : { assignee_agent: agent.trim() }),
            ...(blockedBy === undefined ? {} : { blocked_by: blockedBy }),
            ...(fingerprint === undefined
              ? {}
              : { origin_fingerprint: fingerprint.trim() }),
          });
          if (flags.json) emitJson(response);
          else {
            const verb = response.created ? "Created" : "Reused";
            process.stdout.write(
              `${status.ok(`${verb} task ${response.task.task_id}: ${response.task.title}`)}\n`,
            );
          }
          return 0;
        } catch (error) {
          return surfaceApiError(error);
        }
      }
      case "claim": {
        const id = requireId(rest, "claim");
        const session = requireText(
          takeFlagValue(rest, ["--session"]),
          "--session",
        );
        const leaseSeconds = parseInteger(
          takeNumericFlag(rest, "--lease-seconds"),
          "--lease-seconds",
          { min: 30, max: 86_400 },
        );
        rejectExtraArgs(rest);

        const project = await projectHandle(flags, sdkFactory);
        if (!project) return 1;
        try {
          const response = await project.tasks.claim(id, {
            session_id: session,
            ...(leaseSeconds === undefined
              ? {}
              : { lease_seconds: leaseSeconds }),
          });
          if (flags.json) emitJson(response);
          else {
            const until = response.task.claim_expires_at
              ? ` until ${response.task.claim_expires_at}`
              : "";
            process.stdout.write(
              `${status.ok(`Claimed task ${id} for ${session}${until}`)}\n`,
            );
          }
          return 0;
        } catch (error) {
          return surfaceApiError(error);
        }
      }
      case "done": {
        const id = requireId(rest, "done");
        const session = requireText(
          takeFlagValue(rest, ["--session"]),
          "--session",
        );
        const evidence = requireText(
          takeFlagValue(rest, ["--evidence"]),
          "--evidence",
        );
        const summary = takeFlagValue(rest, ["--summary"]);
        rejectExtraArgs(rest);
        if (summary !== undefined && !summary.trim())
          throw new Error("--summary cannot be empty");

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
          else
            process.stdout.write(
              `${status.ok(`Completed task ${response.task.task_id}`)}\n`,
            );
          return 0;
        } catch (error) {
          return surfaceApiError(error);
        }
      }
      case "block": {
        const id = requireId(rest, "block");
        const session = requireText(
          takeFlagValue(rest, ["--session"]),
          "--session",
        );
        const reason = requireText(
          takeFlagValue(rest, ["--reason"]),
          "--reason",
        );
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
      case "worker": {
        const id = requireId(rest, "worker");
        const session = requireText(takeFlagValue(rest, ["--session"]), "--session");
        const workerSession = requireText(takeFlagValue(rest, ["--worker-session"]), "--worker-session");
        const prompt = requireText(takeFlagValue(rest, ["--prompt"]), "--prompt");
        const maxWallSeconds = requirePositiveInteger(
          takeNumericFlag(rest, "--max-wall-seconds"),
          "--max-wall-seconds",
          TASK_WORKER_PLATFORM_CEILINGS.max_wall_seconds,
        );
        const maxTokens = requirePositiveInteger(
          takeNumericFlag(rest, "--max-tokens"),
          "--max-tokens",
          TASK_WORKER_PLATFORM_CEILINGS.max_tokens,
        );
        const maxCostUsd = requirePositiveNumber(
          takeNumericFlag(rest, "--max-cost-usd"),
          "--max-cost-usd",
          TASK_WORKER_PLATFORM_CEILINGS.max_cost_usd,
        );
        const maxIterations = requirePositiveInteger(
          takeNumericFlag(rest, "--max-iterations"),
          "--max-iterations",
          TASK_WORKER_PLATFORM_CEILINGS.max_iterations,
        );
        rejectExtraArgs(rest);
        const project = await projectHandle(flags, sdkFactory);
        if (!project) return 1;
        try {
          const response = await project.tasks.registerWorker(id, {
            session_id: session, worker_session_id: workerSession, prompt,
            contract: {
              max_wall_seconds: maxWallSeconds, max_tokens: maxTokens,
              max_cost_usd: maxCostUsd, max_iterations: maxIterations,
            },
          });
          if (flags.json) emitJson(response);
          else process.stdout.write(`${status.ok(`Worker ${response.worker.state} for task ${response.task.task_id}`)}\n`);
          return 0;
        } catch (error) { return surfaceApiError(error); }
      }
      case "progress": {
        const id = requireId(rest, "progress");
        const session = requireText(takeFlagValue(rest, ["--session"]), "--session");
        const workerSession = requireText(takeFlagValue(rest, ["--worker-session"]), "--worker-session");
        const ref = requireText(takeFlagValue(rest, ["--ref"]), "--ref");
        rejectExtraArgs(rest);
        const project = await projectHandle(flags, sdkFactory);
        if (!project) return 1;
        try {
          const response = await project.tasks.recordProgress(id, {
            session_id: session, worker_session_id: workerSession, ref,
          });
          if (flags.json) emitJson(response);
          else process.stdout.write(`${status.ok(`Recorded progress for task ${response.task.task_id}`)}\n`);
          return 0;
        } catch (error) { return surfaceApiError(error); }
      }
      case "no-progress": {
        const id = requireId(rest, "no-progress");
        const session = requireText(takeFlagValue(rest, ["--session"]), "--session");
        const workerSession = requireText(takeFlagValue(rest, ["--worker-session"]), "--worker-session");
        const settlementId = requireText(takeFlagValue(rest, ["--settlement-id"]), "--settlement-id");
        const reason = requireText(takeFlagValue(rest, ["--reason"]), "--reason");
        rejectExtraArgs(rest);
        const project = await projectHandle(flags, sdkFactory);
        if (!project) return 1;
        try {
          const response = await project.tasks.settleNoProgress(id, {
            session_id: session, worker_session_id: workerSession, settlement_id: settlementId, reason,
          });
          if (flags.json) emitJson(response);
          else {
            const label = response.action === "continuation_queued" ? "Continue" : "Escalate";
            process.stdout.write(`${status.ok(`${label} task ${response.task.task_id}`)}\n`);
          }
          return 0;
        } catch (error) { return surfaceApiError(error); }
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

function renderTaskList(tasks: ProjectTask[]): void {
  if (tasks.length === 0) {
    process.stdout.write("No tasks match these filters.\n");
    return;
  }
  const statusWidth = Math.max(6, ...tasks.map((task) => task.status.length));
  const goalWidth = Math.max(4, ...tasks.map((task) => task.goal_slug.length));
  process.stdout.write(
    `${pad("ID", 36)}  ${pad("STATUS", statusWidth)}  PRI  ${pad("GOAL", goalWidth)}  TITLE\n`,
  );
  for (const task of tasks) {
    process.stdout.write(
      `${pad(task.task_id, 36)}  ${pad(task.status, statusWidth)}  ${pad(String(task.priority), 3)}  ${pad(task.goal_slug, goalWidth)}  ${task.title}\n`,
    );
  }
}

function renderTask(task: ProjectTask): void {
  process.stdout.write(`${C.bold}${task.title}${C.reset}\n`);
  process.stdout.write(`ID: ${task.task_id}\n`);
  process.stdout.write(`Goal: ${task.goal_slug}\n`);
  process.stdout.write(`Status: ${task.status}\n`);
  process.stdout.write(`Priority: ${task.priority}\n`);
  if (task.assignee_agent)
    process.stdout.write(`Agent: ${task.assignee_agent}\n`);
  if (task.claim_session_id) {
    process.stdout.write(
      `Claim: ${task.claim_session_id}${task.claim_expires_at ? ` until ${task.claim_expires_at}` : ""}\n`,
    );
  }
  if (task.blocked_by.length > 0)
    process.stdout.write(`Blocked by: ${task.blocked_by.join(", ")}\n`);
  if (task.body) process.stdout.write(`\n${task.body}\n`);
  if (Object.keys(task.result).length > 0) {
    process.stdout.write(`Result: ${JSON.stringify(task.result)}\n`);
  }
}

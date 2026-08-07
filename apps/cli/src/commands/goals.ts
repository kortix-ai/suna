import type { ProjectGoal, ProjectGoalObservation } from "@kortix/sdk";

import {
  emitJson,
  resolveProjectContext,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
} from "../command-helpers.ts";
import { kortixFromAuth } from "../api/sdk.ts";
import { C, help, pad, status } from "../style.ts";

const HELP = help`Usage: kortix goals <subcommand> [options]

Inspect and drive the autonomous goals declared in the project manifest.
Use observe to record a metric value. Use push to request a goal run.

Subcommands:
  ls [--json]            List declared goals and parse errors.
  show <slug> [--json]   Show one goal.
  health <slug> [--json] Show deterministic metric and evaluation health.
  push <slug> [--json]   Request an immediate run for one active goal.
  observe <slug>         Record one goal metric observation.
  observations <slug>    List durable observations for one metric.

Observe options:
  --evaluation <id>      Goal evaluation returned by push (required).
  --metric <name>        Metric declared by the goal (required).
  --value <number>       Finite metric value (required).
  --source <text>        Observation source, such as "prometheus" (required).
  --session <id>         Session that produced the observation.
  --observed-at <ISO>    Observation timestamp with timezone (default: now).
  --json                 Print the raw SDK response.

Observation list options:
  --metric <name>        Metric to recover (required).
  --from <ISO>           Earliest observation timestamp.
  --to <ISO>             Latest observation timestamp.
  --limit <n>            Return 1 to 10000 observations.
  --json                 Print the raw SDK response.

Global options:
  --project <id>         Operate on this project id (default: linked/default).
  --host <name>          Use a configured Kortix host.
  -h, --help             Show this help.

Examples:
  kortix goals ls
  kortix goals show reduce-latency --json
  kortix goals health reduce-latency
  kortix goals push reduce-latency
  kortix goals observe reduce-latency --evaluation <push-evaluation-id> --metric p95_ms --value 180 --source prometheus
  kortix goals observations reduce-latency --metric p95_ms --limit 20
`;

type SdkFactory = typeof kortixFromAuth;

export interface GoalsCommandDeps {
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

function parseBoundedInteger(
  raw: string | undefined,
  flag: string,
  min: number,
  max: number,
): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) throw new Error(`${flag} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${flag} must be between ${min} and ${max}`);
  }
  return value;
}

function requireText(value: string | undefined, flag: string): string {
  if (!value?.trim()) throw new Error(`${flag} is required`);
  return value.trim();
}

function requireSlug(argv: string[], action: string): string {
  const slug = argv.shift();
  if (!slug || slug.startsWith("-")) {
    throw new Error(`Pass a goal slug: kortix goals ${action} <slug>`);
  }
  return slug;
}

function rejectExtraArgs(argv: string[]): void {
  if (argv.length === 0) return;
  const arg = argv[0];
  if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
  throw new Error(`Unexpected argument: ${arg}`);
}

async function projectHandle(flags: CommonFlags, sdkFactory: SdkFactory) {
  const ctx = await resolveProjectContext({
    projectArg: flags.project,
    hostArg: flags.host,
  });
  if (!ctx) return null;
  return sdkFactory(ctx.auth).project(ctx.projectId);
}

export async function runGoals(
  argv: string[],
  deps: GoalsCommandDeps = {},
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
        rejectExtraArgs(rest);
        const project = await projectHandle(flags, sdkFactory);
        if (!project) return 1;
        try {
          const response = await project.goals.list();
          if (flags.json) emitJson(response);
          else renderGoalList(response.goals, response.errors);
          return 0;
        } catch (error) {
          return surfaceApiError(error);
        }
      }
      case "show": {
        const slug = requireSlug(rest, "show");
        rejectExtraArgs(rest);
        const project = await projectHandle(flags, sdkFactory);
        if (!project) return 1;
        try {
          const response = await project.goals.get(slug);
          if (flags.json) emitJson(response);
          else renderGoal(response.goal);
          return 0;
        } catch (error) {
          return surfaceApiError(error);
        }
      }
      case "health": {
        const slug = requireSlug(rest, "health");
        rejectExtraArgs(rest);
        const project = await projectHandle(flags, sdkFactory);
        if (!project) return 1;
        try {
          const response = await project.goals.health(slug);
          if (flags.json) emitJson(response);
          else renderGoalHealth(response.health);
          return 0;
        } catch (error) {
          return surfaceApiError(error);
        }
      }
      case "push": {
        const slug = requireSlug(rest, "push");
        rejectExtraArgs(rest);
        const project = await projectHandle(flags, sdkFactory);
        if (!project) return 1;
        try {
          const response = await project.goals.push(slug);
          if (flags.json) emitJson(response);
          else {
            const target = response.session_id
              ? ` session ${response.session_id}`
              : response.command_id
                ? ` command ${response.command_id}`
                : "";
            const reason = response.reason ? ` — ${response.reason}` : "";
            process.stdout.write(
              `${status.ok(`${slug}: ${response.status}${target}; evaluation ${response.evaluation_id} (${response.evaluation_state})${reason}`)}\n`,
            );
          }
          return 0;
        } catch (error) {
          return surfaceApiError(error);
        }
      }
      case "observations":
      case "observation":
      case "obs": {
        const slug = requireSlug(rest, "observations");
        const metric = requireText(
          takeFlagValue(rest, ["--metric"]),
          "--metric",
        );
        const from = takeFlagValue(rest, ["--from"]);
        const to = takeFlagValue(rest, ["--to"]);
        const limit = parseBoundedInteger(
          takeNumericFlag(rest, "--limit"),
          "--limit",
          1,
          10_000,
        );
        rejectExtraArgs(rest);
        if (from !== undefined && !isIsoTimestamp(from)) {
          throw new Error("--from must be an ISO timestamp with a timezone");
        }
        if (to !== undefined && !isIsoTimestamp(to)) {
          throw new Error("--to must be an ISO timestamp with a timezone");
        }
        if (
          from !== undefined &&
          to !== undefined &&
          Date.parse(from) > Date.parse(to)
        ) {
          throw new Error("--from must not be later than --to");
        }

        const project = await projectHandle(flags, sdkFactory);
        if (!project) return 1;
        try {
          const response = await project.goals.observations.list(slug, {
            metric,
            ...(from === undefined ? {} : { from }),
            ...(to === undefined ? {} : { to }),
            ...(limit === undefined ? {} : { limit }),
          });
          if (flags.json) emitJson(response);
          else renderObservations(response.observations);
          return 0;
        } catch (error) {
          return surfaceApiError(error);
        }
      }
      case "observe": {
        const slug = requireSlug(rest, "observe");
        const evaluationIdRaw = takeFlagValue(rest, ["--evaluation"]);
        const metric = requireText(
          takeFlagValue(rest, ["--metric"]),
          "--metric",
        );
        const rawValue = requireText(
          takeNumericFlag(rest, "--value"),
          "--value",
        );
        const source = requireText(
          takeFlagValue(rest, ["--source"]),
          "--source",
        );
        const session = takeFlagValue(rest, ["--session"]);
        const observedAt = takeFlagValue(rest, ["--observed-at"]);
        rejectExtraArgs(rest);

        const value = Number(rawValue);
        if (!Number.isFinite(value))
          throw new Error("--value must be a finite number");
        if (session !== undefined && !session.trim())
          throw new Error("--session cannot be empty");
        if (observedAt !== undefined && !isIsoTimestamp(observedAt)) {
          throw new Error(
            "--observed-at must be an ISO timestamp with a timezone",
          );
        }
        const evaluationId = requireText(evaluationIdRaw, "--evaluation");

        const project = await projectHandle(flags, sdkFactory);
        if (!project) return 1;
        try {
          const response = await project.goals.observations.record(slug, {
            evaluation_id: evaluationId,
            metric,
            value,
            source,
            ...(session === undefined ? {} : { session_id: session }),
            ...(observedAt === undefined ? {} : { observed_at: observedAt }),
          });
          if (flags.json) emitJson(response);
          else {
            process.stdout.write(
              `${status.ok(`Observed ${slug}.${metric}=${value} (${response.observation.observation_id})`)}\n`,
            );
          }
          return 0;
        } catch (error) {
          return surfaceApiError(error);
        }
      }
      default:
        process.stderr.write(
          `${status.err(`Unknown goals subcommand "${subcommand}"`)}\n\n${HELP}`,
        );
        return 2;
    }
  } catch (error) {
    process.stderr.write(
      `${status.err((error as Error).message)}\n\nRun ${C.cyan}kortix goals --help${C.reset}.\n`,
    );
    return 2;
  }
}

function isIsoTimestamp(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ) && Number.isFinite(Date.parse(value))
  );
}

function renderGoalHealth(health: {
  goal_slug: string;
  desired_status: string;
  health_status: string;
  metrics: Array<{
    metric: string;
    status: string;
    evaluation_id: string | null;
    evaluation_state: string | null;
    observation_value: number | null;
  }>;
}): void {
  process.stdout.write(`Goal: ${health.goal_slug}\n`);
  process.stdout.write(`Desired status: ${health.desired_status}\n`);
  process.stdout.write(`Health: ${health.health_status}\n`);
  for (const metric of health.metrics) {
    const value = metric.observation_value === null ? "unobserved" : String(metric.observation_value);
    const evaluation = metric.evaluation_id
      ? ` evaluation=${metric.evaluation_id} (${metric.evaluation_state})`
      : "";
    process.stdout.write(`  ${metric.metric}: ${metric.status} value=${value}${evaluation}\n`);
  }
}

function renderObservations(observations: ProjectGoalObservation[]): void {
  if (observations.length === 0) {
    process.stdout.write("No observations match these filters.\n");
    return;
  }
  const metricWidth = Math.max(
    6,
    ...observations.map((item) => item.metric.length),
  );
  process.stdout.write(
    `${pad("OBSERVED AT", 24)}  ${pad("METRIC", metricWidth)}  VALUE  SOURCE\n`,
  );
  for (const item of observations) {
    process.stdout.write(
      `${pad(item.observed_at, 24)}  ${pad(item.metric, metricWidth)}  ${item.value}  ${item.source}\n`,
    );
  }
}

function renderGoalList(
  goals: ProjectGoal[],
  errors: Array<{ slug: string; path: string; error: string }>,
): void {
  if (goals.length === 0) {
    process.stdout.write("No goals declared in the project manifest.\n");
  } else {
    const slugWidth = Math.max(4, ...goals.map((goal) => goal.slug.length));
    const statusWidth = Math.max(6, ...goals.map((goal) => goal.status.length));
    process.stdout.write(
      `${pad("SLUG", slugWidth)}  ${pad("STATUS", statusWidth)}  TITLE\n`,
    );
    for (const goal of goals) {
      process.stdout.write(
        `${pad(goal.slug, slugWidth)}  ${pad(goal.status, statusWidth)}  ${goal.title}\n`,
      );
    }
  }
  for (const error of errors) {
    process.stderr.write(`${status.warn(`${error.path}: ${error.error}`)}\n`);
  }
}

function renderGoal(goal: ProjectGoal): void {
  process.stdout.write(`${C.bold}${goal.title}${C.reset} (${goal.slug})\n`);
  process.stdout.write(`Status: ${goal.status}\n`);
  process.stdout.write(`Done when: ${goal.done_when}\n`);
  if (goal.agent) process.stdout.write(`Agent: ${goal.agent}\n`);
  if (goal.push_cron)
    process.stdout.write(`Push: ${goal.push_cron} (${goal.timezone})\n`);
  if (goal.metrics.length > 0) {
    process.stdout.write("Metrics:\n");
    for (const metric of goal.metrics) {
      const target = metric.target === null ? "" : ` target=${metric.target}`;
      const unit = metric.unit === null ? "" : ` ${metric.unit}`;
      process.stdout.write(
        `  ${metric.name}: ${metric.direction}${target}${unit}\n`,
      );
    }
  }
}

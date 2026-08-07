import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ApiError } from "../api/client.ts";
import type { kortixFromAuth } from "../api/sdk.ts";
import { runGoals } from "./goals.ts";
import { runTasks } from "./tasks.ts";

const ORIGINAL_STDOUT_WRITE = process.stdout.write;
const ORIGINAL_STDERR_WRITE = process.stderr.write;
const ENV_KEYS = [
  "KORTIX_CLI_TOKEN",
  "KORTIX_TOKEN",
  "KORTIX_API_URL",
  "KORTIX_PROJECT_ID",
  "KORTIX_DISABLE_SANDBOX_ENV_FILE",
  "KORTIX_CONFIG_FILE",
  "KORTIX_AUTH_FILE",
] as const;

const GOAL = {
  slug: "reduce-latency",
  path: "goals/reduce-latency.md",
  title: "Reduce latency",
  done_when: "p95 is below 200 ms",
  status: "active" as const,
  push_cron: null,
  timezone: "UTC",
  agent: "operator",
  metrics: [
    { name: "p95_ms", direction: "decrease" as const, target: 200, unit: "ms" },
  ],
};

const TASK = {
  task_id: "11111111-1111-4111-8111-111111111111",
  project_id: "project_1",
  goal_slug: GOAL.slug,
  parent_id: null,
  title: "Add retry telemetry",
  body: "Measure every retry.",
  status: "todo" as const,
  priority: 7,
  assignee_agent: null,
  assignee_user_id: null,
  blocked_by: [],
  origin: "cli",
  origin_fingerprint: null,
  claim_session_id: null,
  claimed_at: null,
  claim_expires_at: null,
  liveness_worker_session_id: null,
  liveness_coordinator_session_id: null,
  liveness_worker_contract: null,
  liveness_started_at: null,
  liveness_deadline_at: null,
  liveness_iterations_admitted: 0,
  no_progress_settlements: 0,
  continuation_consumed_at: null,
  last_progress_at: null,
  last_progress_ref: null,
  last_no_progress_settlement_id: null,
  last_no_progress_action: null,
  last_no_progress_command_id: null,
  escalated_at: null,
  liveness_blocker: null,
  result: {},
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-01T00:00:00.000Z",
};

const OBSERVATION = {
  observation_id: "obs_1",
  project_id: "project_1",
  goal_slug: GOAL.slug,
  metric: "p95_ms",
  value: 180,
  source: "prometheus",
  session_id: "session_1",
  observed_at: "2026-08-01T12:00:00.000Z",
  created_at: "2026-08-01T12:00:01.000Z",
};

type Call = { method: string; args: unknown[]; projectId: string };

let saved: Record<string, string | undefined>;
let tmp: string;
let stdout = "";
let stderr = "";
let calls: Call[];
let failures: Record<string, unknown>;

function responseOrThrow<T>(method: string, response: T): T {
  if (method in failures) throw failures[method];
  return response;
}

function fakeSdkFactory() {
  return ((auth: { token: string; api_base: string }) => {
    expect(auth.token).toBe("tok_test");
    expect(auth.api_base).toBe("https://api.test");
    return {
      project(projectId: string) {
        const record = (method: string, args: unknown[], response: unknown) => {
          calls.push({ method, args, projectId });
          return Promise.resolve(responseOrThrow(method, response));
        };
        return {
          goals: {
            list: () => record("goals.list", [], { goals: [GOAL], errors: [] }),
            get: (...args: unknown[]) =>
              record("goals.get", args, { goal: GOAL }),
            push: (...args: unknown[]) =>
              record("goals.push", args, {
                status: "fired",
                session_id: "session_1",
              }),
            observations: {
              record: (...args: unknown[]) =>
                record("goals.observations.record", args, {
                  observation: OBSERVATION,
                }),
              list: (...args: unknown[]) =>
                record("goals.observations.list", args, {
                  observations: [OBSERVATION],
                }),
            },
          },
          tasks: {
            list: (...args: unknown[]) =>
              record("tasks.list", args, { tasks: [TASK] }),
            get: (...args: unknown[]) =>
              record("tasks.get", args, { task: TASK }),
            create: (...args: unknown[]) =>
              record("tasks.create", args, { task: TASK, created: true }),
            claim: (...args: unknown[]) =>
              record("tasks.claim", args, {
                task: {
                  ...TASK,
                  status: "doing",
                  claim_expires_at: "2026-08-01T12:15:00.000Z",
                },
              }),
            complete: (...args: unknown[]) =>
              record("tasks.complete", args, {
                task: { ...TASK, status: "done" },
              }),
            block: (...args: unknown[]) =>
              record("tasks.block", args, {
                task: { ...TASK, status: "blocked" },
              }),
            registerWorker: (...args: unknown[]) =>
              record("tasks.registerWorker", args, {
                task: { ...TASK, status: "doing" },
                worker: { session_id: "worker-session", command_id: "command-1", state: "queued" },
                contract: { max_wall_seconds: 3600, max_tokens: 1000000, max_cost_usd: 25, max_iterations: 128 },
              }),
            recordProgress: (...args: unknown[]) =>
              record("tasks.recordProgress", args, { task: { ...TASK, status: "doing" }, action: "recorded" }),
            settleNoProgress: (...args: unknown[]) =>
              record("tasks.settleNoProgress", args, {
                action: "continuation_queued",
                task: {
                  ...TASK,
                  status: "doing",
                  no_progress_settlements: 1,
                },
              }),
          },
        };
      },
    };
  }) as unknown as typeof kortixFromAuth;
}

function commandArgs(args: string[]): string[] {
  return [...args, "--project", "project_1", "--host", "test"];
}

function resetOutput(): void {
  stdout = "";
  stderr = "";
}

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.KORTIX_DISABLE_SANDBOX_ENV_FILE = "1";
  tmp = mkdtempSync(join(tmpdir(), "kortix-goals-tasks-"));
  const configFile = join(tmp, "config.json");
  writeFileSync(
    configFile,
    JSON.stringify({
      active: "test",
      hosts: {
        test: {
          url: "https://api.test",
          token: "tok_test",
          user_id: "user_1",
          user_email: "user@example.test",
          account_id: "account_1",
          logged_in_at: "2026-08-01T00:00:00.000Z",
        },
      },
    }),
  );
  process.env.KORTIX_CONFIG_FILE = configFile;
  calls = [];
  failures = {};
  resetOutput();
  (process.stdout as { write: typeof process.stdout.write }).write = ((
    chunk: unknown,
  ) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  (process.stderr as { write: typeof process.stderr.write }).write = ((
    chunk: unknown,
  ) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stdout.write = ORIGINAL_STDOUT_WRITE;
  process.stderr.write = ORIGINAL_STDERR_WRITE;
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe("goals command", () => {
  test("executes every SDK operation and preserves raw JSON responses", async () => {
    const sdk = fakeSdkFactory();

    let code = await runGoals(commandArgs(["ls", "--json"]), {
      kortixFromAuth: sdk,
    });
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ goals: [GOAL], errors: [] });
    expect(stderr).toBe("");
    resetOutput();

    code = await runGoals(commandArgs(["show", GOAL.slug, "--json"]), {
      kortixFromAuth: sdk,
    });
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ goal: GOAL });
    expect(stderr).toBe("");
    resetOutput();

    code = await runGoals(commandArgs(["push", GOAL.slug]), {
      kortixFromAuth: sdk,
    });
    expect(code).toBe(0);
    expect(stdout).toContain("reduce-latency: fired session session_1");
    expect(stderr).toBe("");
    resetOutput();

    code = await runGoals(
      commandArgs([
        "observe",
        GOAL.slug,
        "--metric",
        "p95_ms",
        "--value",
        "-12.5",
        "--source",
        "prometheus",
        "--session",
        "session_1",
        "--observed-at",
        "2026-08-01T12:00:00.000Z",
        "--json",
      ]),
      { kortixFromAuth: sdk },
    );
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ observation: OBSERVATION });
    expect(stderr).toBe("");
    resetOutput();

    code = await runGoals(
      commandArgs([
        "observations",
        GOAL.slug,
        "--metric",
        "p95_ms",
        "--from",
        "2026-08-01T00:00:00Z",
        "--to",
        "2026-08-02T00:00:00Z",
        "--limit",
        "20",
      ]),
      { kortixFromAuth: sdk },
    );
    expect(code).toBe(0);
    expect(stdout).toContain("OBSERVED AT");
    expect(stdout).toContain("prometheus");
    expect(stderr).toBe("");

    expect(calls).toEqual([
      { method: "goals.list", args: [], projectId: "project_1" },
      { method: "goals.get", args: [GOAL.slug], projectId: "project_1" },
      { method: "goals.push", args: [GOAL.slug], projectId: "project_1" },
      {
        method: "goals.observations.record",
        projectId: "project_1",
        args: [
          GOAL.slug,
          {
            metric: "p95_ms",
            value: -12.5,
            source: "prometheus",
            session_id: "session_1",
            observed_at: "2026-08-01T12:00:00.000Z",
          },
        ],
      },
      {
        method: "goals.observations.list",
        projectId: "project_1",
        args: [
          GOAL.slug,
          {
            metric: "p95_ms",
            from: "2026-08-01T00:00:00Z",
            to: "2026-08-02T00:00:00Z",
            limit: 20,
          },
        ],
      },
    ]);
  });

  test("rejects invalid values, timestamps, and observation limits before the SDK call", async () => {
    const sdk = fakeSdkFactory();
    for (const [args, message] of [
      [
        [
          "observe",
          GOAL.slug,
          "--metric",
          "p95_ms",
          "--value",
          "Infinity",
          "--source",
          "x",
        ],
        "finite number",
      ],
      [
        [
          "observe",
          GOAL.slug,
          "--metric",
          "p95_ms",
          "--value",
          "1",
          "--source",
          "x",
          "--observed-at",
          "yesterday",
        ],
        "ISO timestamp",
      ],
      [
        ["observations", GOAL.slug, "--metric", "p95_ms", "--limit", "10001"],
        "between 1 and 10000",
      ],
      [
        [
          "observations",
          GOAL.slug,
          "--metric",
          "p95_ms",
          "--from",
          "2026-08-03T00:00:00Z",
          "--to",
          "2026-08-02T00:00:00Z",
        ],
        "must not be later",
      ],
    ] as const) {
      resetOutput();
      const code = await runGoals(commandArgs([...args]), {
        kortixFromAuth: sdk,
      });
      expect(code).toBe(2);
      expect(stdout).toBe("");
      expect(stderr).toContain(message);
      expect(stderr).toContain("kortix goals --help");
    }
    expect(calls).toEqual([]);
  });

  test("surfaces ApiError through the shared CLI error formatter", async () => {
    failures["goals.get"] = new ApiError(404, 'Goal "missing" was not found');
    const code = await runGoals(commandArgs(["show", "missing"]), {
      kortixFromAuth: fakeSdkFactory(),
    });
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain('Goal "missing" was not found');
    expect(calls).toEqual([
      { method: "goals.get", args: ["missing"], projectId: "project_1" },
    ]);
  });
});

describe("tasks command", () => {
  test("executes every SDK operation with validated and translated arguments", async () => {
    const sdk = fakeSdkFactory();

    let code = await runTasks(
      commandArgs([
        "ls",
        "--goal",
        GOAL.slug,
        "--status",
        "todo",
        "--limit",
        "25",
        "--json",
      ]),
      { kortixFromAuth: sdk },
    );
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ tasks: [TASK] });
    expect(stderr).toBe("");
    resetOutput();

    code = await runTasks(commandArgs(["show", TASK.task_id]), {
      kortixFromAuth: sdk,
    });
    expect(code).toBe(0);
    expect(stdout).toContain("Add retry telemetry");
    expect(stdout).toContain(TASK.task_id);
    expect(stderr).toBe("");
    resetOutput();

    code = await runTasks(
      commandArgs([
        "new",
        "--goal",
        GOAL.slug,
        "--title",
        TASK.title,
        "--body",
        TASK.body,
        "--priority",
        "-3",
        "--status",
        "todo",
        "--agent",
        "worker",
        "--blocked-by",
        "task_a,task_b",
        "--fingerprint",
        "retry-telemetry-v1",
        "--json",
      ]),
      { kortixFromAuth: sdk },
    );
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ task: TASK, created: true });
    expect(stderr).toBe("");
    resetOutput();

    code = await runTasks(
      commandArgs([
        "claim",
        TASK.task_id,
        "--session",
        "session_1",
        "--lease-seconds",
        "900",
      ]),
      { kortixFromAuth: sdk },
    );
    expect(code).toBe(0);
    expect(stdout).toContain("Claimed task");
    expect(stderr).toBe("");
    resetOutput();

    code = await runTasks(
      commandArgs([
        "done",
        TASK.task_id,
        "--session",
        "session_1",
        "--evidence",
        "pr:123",
        "--summary",
        "Merged retry telemetry",
      ]),
      { kortixFromAuth: sdk },
    );
    expect(code).toBe(0);
    expect(stdout).toContain("Completed task");
    expect(stderr).toBe("");
    resetOutput();

    code = await runTasks(
      commandArgs([
        "block",
        TASK.task_id,
        "--session",
        "session_1",
        "--reason",
        "Waiting for API",
      ]),
      { kortixFromAuth: sdk },
    );
    expect(code).toBe(0);
    expect(stdout).toContain("Blocked task");
    expect(stderr).toBe("");
    resetOutput();

    code = await runTasks(
      commandArgs([
        "worker", TASK.task_id, "--session", "coordinator-session",
        "--worker-session", "worker-session", "--prompt", "Implement and verify",
        "--max-wall-seconds", "3600", "--max-tokens", "1000000",
        "--max-cost-usd", "25", "--max-iterations", "128",
      ]), { kortixFromAuth: sdk },
    );
    expect(code).toBe(0);
    expect(stdout).toContain("Worker queued");
    resetOutput();

    code = await runTasks(
      commandArgs([
        "progress", TASK.task_id, "--session", "coordinator-session",
        "--worker-session", "worker-session", "--ref", "commit:abc123",
      ]), { kortixFromAuth: sdk },
    );
    expect(code).toBe(0);
    expect(stdout).toContain("Recorded progress");
    resetOutput();

    code = await runTasks(
      commandArgs([
        "no-progress", TASK.task_id, "--session", "coordinator-session",
        "--worker-session", "worker-session", "--settlement-id", "turn-1",
        "--reason", "Settled without evidence",
      ]), { kortixFromAuth: sdk },
    );
    expect(code).toBe(0);
    expect(stdout).toContain("Continue task");
    expect(stderr).toBe("");

    expect(calls).toEqual([
      {
        method: "tasks.list",
        projectId: "project_1",
        args: [{ goal_slug: GOAL.slug, statuses: ["todo"], limit: 25 }],
      },
      { method: "tasks.get", projectId: "project_1", args: [TASK.task_id] },
      {
        method: "tasks.create",
        projectId: "project_1",
        args: [
          {
            goal_slug: GOAL.slug,
            title: TASK.title,
            origin: "cli",
            body: TASK.body,
            priority: -3,
            status: "todo",
            assignee_agent: "worker",
            blocked_by: ["task_a", "task_b"],
            origin_fingerprint: "retry-telemetry-v1",
          },
        ],
      },
      {
        method: "tasks.claim",
        projectId: "project_1",
        args: [TASK.task_id, { session_id: "session_1", lease_seconds: 900 }],
      },
      {
        method: "tasks.complete",
        projectId: "project_1",
        args: [
          TASK.task_id,
          {
            session_id: "session_1",
            evidence: [{ ref: "pr:123", summary: "Merged retry telemetry" }],
          },
        ],
      },
      {
        method: "tasks.block",
        projectId: "project_1",
        args: [
          TASK.task_id,
          { session_id: "session_1", blocker: "Waiting for API" },
        ],
      },
      {
        method: "tasks.registerWorker", projectId: "project_1",
        args: [TASK.task_id, {
          session_id: "coordinator-session", worker_session_id: "worker-session",
          prompt: "Implement and verify",
          contract: { max_wall_seconds: 3600, max_tokens: 1000000, max_cost_usd: 25, max_iterations: 128 },
        }],
      },
      {
        method: "tasks.recordProgress", projectId: "project_1",
        args: [TASK.task_id, {
          session_id: "coordinator-session", worker_session_id: "worker-session", ref: "commit:abc123",
        }],
      },
      {
        method: "tasks.settleNoProgress", projectId: "project_1",
        args: [TASK.task_id, {
          session_id: "coordinator-session", worker_session_id: "worker-session",
          settlement_id: "turn-1", reason: "Settled without evidence",
        }],
      },
    ]);
  });

  test("rejects statuses, numeric bounds, and missing evidence before the SDK call", async () => {
    const sdk = fakeSdkFactory();
    for (const [args, message] of [
      [["ls", "--status", "ready"], "must be one of"],
      [["ls", "--limit", "0"], "between 1 and 1000"],
      [
        ["new", "--goal", GOAL.slug, "--title", TASK.title, "--status", "done"],
        "creatable status",
      ],
      [
        [
          "new",
          "--goal",
          GOAL.slug,
          "--title",
          TASK.title,
          "--priority",
          "1.5",
        ],
        "must be an integer",
      ],
      [
        [
          "claim",
          TASK.task_id,
          "--session",
          "session_1",
          "--lease-seconds",
          "29",
        ],
        "between 30 and 86400",
      ],
      [
        [
          "worker", TASK.task_id, "--session", "coordinator-session",
          "--worker-session", "worker-session", "--prompt", "work",
          "--max-wall-seconds", "900", "--max-tokens", "0",
          "--max-cost-usd", "2.5", "--max-iterations", "8",
        ],
        "--max-tokens must be a positive integer",
      ],
      [
        [
          "worker", TASK.task_id, "--session", "coordinator-session",
          "--worker-session", "worker-session", "--prompt", "work",
          "--max-wall-seconds", "3601", "--max-tokens", "50000",
          "--max-cost-usd", "2.5", "--max-iterations", "8",
        ],
        "--max-wall-seconds must be between 1 and 3600",
      ],
      [
        [
          "worker", TASK.task_id, "--session", "coordinator-session",
          "--worker-session", "worker-session", "--prompt", "work",
          "--max-wall-seconds", "900", "--max-tokens", "1000001",
          "--max-cost-usd", "2.5", "--max-iterations", "8",
        ],
        "--max-tokens must be between 1 and 1000000",
      ],
      [
        [
          "worker", TASK.task_id, "--session", "coordinator-session",
          "--worker-session", "worker-session", "--prompt", "work",
          "--max-wall-seconds", "900", "--max-tokens", "50000",
          "--max-cost-usd", "25.000001", "--max-iterations", "8",
        ],
        "--max-cost-usd must be between 0 (exclusive) and 25",
      ],
      [
        [
          "worker", TASK.task_id, "--session", "coordinator-session",
          "--worker-session", "worker-session", "--prompt", "work",
          "--max-wall-seconds", "900", "--max-tokens", "50000",
          "--max-cost-usd", "2.5", "--max-iterations", "129",
        ],
        "--max-iterations must be between 1 and 128",
      ],
      [
        ["done", TASK.task_id, "--session", "session_1"],
        "--evidence is required",
      ],
      [
        ["done", TASK.task_id, "--session", "session_1", "--evidence="],
        "--evidence is required",
      ],
    ] as const) {
      resetOutput();
      const code = await runTasks(commandArgs([...args]), {
        kortixFromAuth: sdk,
      });
      expect(code).toBe(2);
      expect(stdout).toBe("");
      expect(stderr).toContain(message);
      expect(stderr).toContain("kortix tasks --help");
    }
    expect(calls).toEqual([]);
  });
});

/**
 * Structured result model. A single results.json is the only artifact the
 * report viewer and the coverage gate consume — everything else derives from it.
 */

export type Status = "pass" | "fail" | "skip" | "todo";

export interface CapturedRequest {
  method: string;
  url: string;
  /** Redacted at capture time. */
  headers: Record<string, string>;
  body?: string;
}

export interface CapturedResponse {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
  /** Parsed JSON body if content was JSON, else undefined. */
  json?: unknown;
}

export interface Captured {
  /** Path template the client was given (normalized), for coverage aggregation. e.g. GET /v1/projects/:id */
  routeTemplate: string;
  req: CapturedRequest;
  res: CapturedResponse;
  ms: number;
}

export interface Assertion {
  kind: string;
  description: string;
  expected: unknown;
  actual: unknown;
  pass: boolean;
}

export interface StepResult {
  name: string;
  status: Status;
  durationMs: number;
  requests: Captured[];
  assertions: Assertion[];
  error?: { message: string; stack?: string };
}

export interface FlowResult {
  id: string;
  domain: string;
  tags: string[];
  status: Status;
  reason?: string;
  durationMs: number;
  attempts: number;
  steps: StepResult[];
  /** meta.quarantine — reported, never run; exempt from --require-all. */
  quarantined?: boolean;
  /**
   * A "skip" that first PASSED at least one step: the flow asserted the
   * contract that is reachable on this target and documented why the rest is
   * not (e.g. CHN-6 asserts the Slack install gate, then skips the dispatch
   * that needs a real workspace). Distinct from a skip that ran nothing.
   */
  asserted?: boolean;
}

export interface RunSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  todo: number;
  /** Skips that ran nothing and are not quarantined — --require-all fails on these. */
  skippedUnasserted: number;
  /** meta.quarantine flows — reported loudly, exempt from --require-all. */
  quarantined: number;
  durationMs: number;
}

export interface FixtureStats {
  databaseProjectCount: number;
  managedProjectCount: number;
}

export interface RunResult {
  runId: string;
  startedAt: string;
  finishedAt: string;
  apiUrl: string;
  target: string;
  gitSha: string | null;
  capabilities: Record<string, boolean>;
  profile?: "all" | "local";
  excludedFlows?: Array<{ id: string; reason: string }>;
  /** Run-scoped project fixtures created before teardown starts. */
  fixtureStats: FixtureStats;
  /** Every route template touched across the run (for coverage). */
  routesHit: string[];
  flows: FlowResult[];
  summary: RunSummary;
}

export function summarize(flows: FlowResult[], durationMs: number): RunSummary {
  return {
    total: flows.length,
    passed: flows.filter((f) => f.status === "pass").length,
    failed: flows.filter((f) => f.status === "fail").length,
    skipped: flows.filter((f) => f.status === "skip").length,
    todo: flows.filter((f) => f.status === "todo").length,
    skippedUnasserted: flows.filter(
      (f) => f.status === "skip" && !f.quarantined && !f.asserted,
    ).length,
    quarantined: flows.filter((f) => f.quarantined === true).length,
    durationMs,
  };
}

/**
 * --require-all is an anti-shrinkage gate: a release run must exercise every
 * registered contract. It fails on `todo` (unimplemented contract) and on any
 * skip that RAN NOTHING (a capability missing on the release target is a
 * misconfigured target, not a pass). It accepts two documented outcomes:
 *  - a skip that first passed ≥1 step (`asserted`) — the flow proved the
 *    contract reachable on this target and named why the rest is not;
 *  - `quarantine` — a named, tracked pre-existing defect, reported loudly.
 */
export function runExitCode(
  summary: Pick<RunSummary, "failed" | "skipped" | "todo" | "skippedUnasserted">,
  requireAll = false,
): 0 | 1 {
  if (summary.failed > 0) return 1;
  if (requireAll && (summary.skippedUnasserted > 0 || summary.todo > 0)) return 1;
  return 0;
}

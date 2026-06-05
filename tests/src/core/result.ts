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
}

export interface RunSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  todo: number;
  durationMs: number;
}

export interface RunResult {
  runId: string;
  startedAt: string;
  finishedAt: string;
  apiUrl: string;
  target: string;
  gitSha: string | null;
  capabilities: Record<string, boolean>;
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
    durationMs,
  };
}

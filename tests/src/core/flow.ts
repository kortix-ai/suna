/**
 * Flow registration. Each test declares its stable spec ID up front — this is
 * the 1:1 mapping that makes end-to-end.md enforceable as the source of truth.
 */
import type { FlowFn, FlowMeta } from "./types";

export interface RegisteredFlow {
  id: string;
  meta: FlowMeta;
  fn: FlowFn;
}

export const DEFAULT_FLOW_ATTEMPTS = 3;
/**
 * A flow-level timeout is a hang, not an infrastructure blip. Retrying it burns
 * the full declared timeout again for a flow that was already the most
 * expensive in the run, so the default budget is a single attempt.
 */
export const DEFAULT_TIMEOUT_ATTEMPTS = 1;
/**
 * "Timed out waiting for session runtime ready" IS worth one retry (a cold
 * sandbox pool recovers), but two attempts of a 5–7 minute wait is the ceiling.
 */
export const DEFAULT_SESSION_RUNTIME_ATTEMPTS = 2;

/**
 * Per-flow wall-clock budget for a flow that declares no `meta.timeoutMs`.
 *
 * 120 s is sized for the LOCAL profile (local API, local Postgres, bare git).
 * Against a deployed target it is too tight: run 32231251280 lost ~50% of its
 * flows to `flow X exceeded 120000ms` on live staging, where every request
 * crosses Cloudflare and real cloud sandboxes are provisioned. `KE2E_FLOW_TIMEOUT_MS`
 * raises it per profile — `local-runner.ts` sets 180 s on the `target-api-full`
 * lane. Keep this constant in sync with `shard.ts`'s `DEFAULT_FLOW_WEIGHT_MS`,
 * which uses the same number as a static scheduling weight.
 */
export const DEFAULT_FLOW_TIMEOUT_MS = 120_000;

/** Marker set by withTimeout on the flow-level timeout error. */
export const KE2E_FLOW_TIMEOUT = 'ke2eFlowTimeout';
/** Marker set by markSessionReadinessTimeoutRetryable. */
export const KE2E_RETRY_CLASS = 'ke2eRetryClass';

export type FlowRetryClass = 'assertion' | 'timeout' | 'session-runtime' | 'infra' | 'fatal';

export interface AttemptPolicy {
  /** Budget for ordinary marked-retryable infra errors (network, laundered 503). */
  infra: number;
  /** Budget for a flow-level timeout. */
  timeout: number;
  /** Budget for a session-runtime-readiness timeout. */
  sessionRuntime: number;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.trunc(parsed));
}

/**
 * Read the per-class attempt budget from the environment.
 *
 * `KE2E_FLOW_ATTEMPTS` sets the infra class only. Timeouts and session-runtime
 * readiness have their own knobs, so raising the infra budget can never
 * re-inflate the serial tail.
 *
 * `KE2E_DEFAULT_FLOW_ATTEMPTS` is the LEGACY name and keeps its old meaning: a
 * ceiling over every class. The local profile and the preview stack both pin it
 * to 1 to make their runs deterministic (local-profile.ts, preview-stack.ts),
 * and that must keep capping timeouts and readiness waits, not just infra.
 */
export function readAttemptPolicy(
  vars: Record<string, string | undefined> = process.env,
): AttemptPolicy {
  const policy: AttemptPolicy = {
    infra: positiveInt(
      vars.KE2E_FLOW_ATTEMPTS ?? vars.KE2E_DEFAULT_FLOW_ATTEMPTS,
      DEFAULT_FLOW_ATTEMPTS,
    ),
    timeout: positiveInt(vars.KE2E_TIMEOUT_ATTEMPTS, DEFAULT_TIMEOUT_ATTEMPTS),
    sessionRuntime: positiveInt(
      vars.KE2E_SESSION_RUNTIME_ATTEMPTS,
      DEFAULT_SESSION_RUNTIME_ATTEMPTS,
    ),
  };
  if (vars.KE2E_DEFAULT_FLOW_ATTEMPTS !== undefined && vars.KE2E_DEFAULT_FLOW_ATTEMPTS !== '') {
    const ceiling = positiveInt(vars.KE2E_DEFAULT_FLOW_ATTEMPTS, DEFAULT_FLOW_ATTEMPTS);
    policy.infra = Math.min(policy.infra, ceiling);
    policy.timeout = Math.min(policy.timeout, ceiling);
    policy.sessionRuntime = Math.min(policy.sessionRuntime, ceiling);
  }
  return policy;
}

/**
 * Resolve the wall-clock budget for one flow.
 *
 * - `KE2E_FLOW_TIMEOUT_MS` unset → today's behaviour exactly: the flow's own
 *   `meta.timeoutMs`, else `DEFAULT_FLOW_TIMEOUT_MS`.
 * - `KE2E_FLOW_TIMEOUT_MS` set → a FLOOR, never a cap. A flow that declares a
 *   LARGER budget (session/CLI flows declare 300 s–20 min) keeps its own; a flow
 *   that declares a smaller one is raised to the floor, because a budget tuned
 *   for the local stack does not survive a deployed target.
 *
 * This is deliberately a floor and not an override: the declared budgets encode
 * real per-flow knowledge (a `kortix ship` flow genuinely needs 20 minutes) and
 * one env var must not silently shorten them.
 */
export function resolveFlowTimeoutMs(
  declaredMs: number | undefined,
  vars: Record<string, string | undefined> = process.env,
): number {
  const raw = vars.KE2E_FLOW_TIMEOUT_MS;
  const parsed = raw === undefined || raw === '' ? Number.NaN : Number(raw);
  // A garbage or non-positive value must never shrink the budget to nothing —
  // a 1 ms timeout would fail every flow instantly. Fall back to the default.
  const configured = Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : undefined;
  if (declaredMs === undefined) return configured ?? DEFAULT_FLOW_TIMEOUT_MS;
  return configured === undefined ? declaredMs : Math.max(declaredMs, configured);
}

/**
 * Classify a flow error into its retry class.
 *
 * `isAssertion` is passed in so this module stays free of the assertion layer.
 */
export function classifyFlowError(error: unknown, isAssertion: boolean): FlowRetryClass {
  if (isAssertion) return 'assertion';
  const marked = error as Record<string, unknown> | null | undefined;
  if (marked?.[KE2E_FLOW_TIMEOUT] === true) return 'timeout';
  if (marked?.ke2eRetryable !== true) return 'fatal';
  if (marked[KE2E_RETRY_CLASS] === 'session-runtime') return 'session-runtime';
  return 'infra';
}

/** Total attempts allowed for one error class. 1 means "never retry". */
export function attemptsFor(retryClass: FlowRetryClass, policy: AttemptPolicy): number {
  switch (retryClass) {
    case 'timeout':
      return policy.timeout;
    case 'session-runtime':
      return policy.sessionRuntime;
    case 'infra':
      return policy.infra;
    default:
      return 1;
  }
}

/**
 * Upper bound on the attempt loop across every class, so the loop can be
 * written once and the per-error cap applied when the error is known.
 */
export function maxAttemptBound(policy: AttemptPolicy): number {
  return Math.max(policy.infra, policy.timeout, policy.sessionRuntime, 1);
}

const registry = new Map<string, RegisteredFlow>();

/**
 * Register a flow. Duplicate IDs throw immediately (caught at import time).
 * Validity against the spec ID set is enforced separately by the coverage gate.
 */
export function flow(id: string, meta: FlowMeta, fn: FlowFn): void {
  if (registry.has(id)) {
    throw new Error(`Duplicate flow id "${id}" — every flow maps 1:1 to a spec ID.`);
  }
  registry.set(id, { id, meta, fn });
}

export function allFlows(): RegisteredFlow[] {
  return [...registry.values()];
}

export function clearRegistry(): void {
  registry.clear();
}

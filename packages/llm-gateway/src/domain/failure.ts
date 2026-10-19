/**
 * Where a candidate failed. `resolve`: the routed model had no usable upstream
 * (every own key or ChatGPT account paused or needing reconnection), so the
 * project's chain started without it. `held`: the same caller's routed model
 * failed moments ago and is still held (pipeline/route-memory.ts), so the plan
 * started at the fallback that answered then.
 */
export type GatewayAttemptFailureStage =
  | 'resolve'
  | 'held'
  | 'dispatch'
  | 'stream_error'
  | 'stream_probe'
  | 'completion_validation';

/**
 * One rejected upstream candidate in the order the gateway observed it.
 *
 * `attempt` identifies the candidate failure in this chain. It does not count
 * hidden transport retries, which remain available through `GatewayTrace.attempts`.
 */
export interface GatewayAttemptFailure {
  attempt: number;
  provider: string;
  routeModel: string;
  resolvedModel: string;
  stage: GatewayAttemptFailureStage;
  status?: number;
  code: string | number;
  message: string;
}

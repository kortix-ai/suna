export type GatewayAttemptFailureStage =
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

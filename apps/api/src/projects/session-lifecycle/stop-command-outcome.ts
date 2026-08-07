export type StopCommandResult = {
  status: number;
  body: Record<string, unknown>;
};

/** A stop command is complete only after the runtime is stopped or absent. */
export function classifyStopCommandResult(
  result: StopCommandResult,
): 'succeeded' | 'retry' | 'failed' {
  if (result.status === 200 || result.status === 404) return 'succeeded';
  if (result.status === 409 && result.body.status === 'stopped') return 'succeeded';
  if (
    (result.status === 409 && result.body.status === 'provisioning') ||
    result.status === 429 ||
    result.status >= 500
  ) {
    return 'retry';
  }
  return 'failed';
}

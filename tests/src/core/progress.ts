import type { FlowResult } from './result';

export function formatFlowProgress(
  result: FlowResult,
  completed: number,
  total: number,
): string {
  const status = result.status.toUpperCase();
  const duration = `${(result.durationMs / 1000).toFixed(1)}s`;
  const attempts = result.attempts > 1 ? ` attempts=${result.attempts}` : '';
  const reason = result.reason ? ` — ${result.reason}` : '';
  return `[${completed}/${total}] ${status} ${result.id} ${duration}${attempts}${reason}`;
}

import type { FlowResult } from './result';

const SENSITIVE_QUERY_VALUE =
  /([?&](?:token|access_token|refresh_token|code|sig|signature|api_key|client_secret|password|secret|credential)=)[^&#\s]*/gi;

export function redactSensitiveLogText(text: string): string {
  return text.replace(SENSITIVE_QUERY_VALUE, '$1[REDACTED]');
}

export function formatFlowProgress(
  result: FlowResult,
  completed: number,
  total: number,
): string {
  const status = result.status.toUpperCase();
  const duration = `${(result.durationMs / 1000).toFixed(1)}s`;
  const attempts = result.attempts > 1 ? ` attempts=${result.attempts}` : '';
  const reason = result.reason ? ` — ${redactSensitiveLogText(result.reason)}` : '';
  return `[${completed}/${total}] ${status} ${result.id} ${duration}${attempts}${reason}`;
}

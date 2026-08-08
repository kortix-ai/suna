import { createHash } from 'node:crypto';

export function auditWebhookFailureSummary(
  kind: 'blocked' | 'http' | 'network',
  raw: string,
  status?: number,
): string {
  const fingerprint = createHash('sha256').update(raw).digest('hex');
  if (kind === 'http') return `HTTP ${status ?? 0}; response_sha256=${fingerprint}`;
  return `${kind}_error; error_sha256=${fingerprint}`;
}

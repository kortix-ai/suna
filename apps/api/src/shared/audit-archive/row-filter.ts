/**
 * The in-memory twin of `buildFilters` (accounts/audit-filters.ts): the same filters, applied to
 * a row read back from the archive instead of a SQL predicate. A filter added to one must be
 * added to the other; `export-page.integration.test.ts` runs both over the same rows.
 */
import type { AuditFilterInput } from '../../accounts/audit-filters';

/** The first day audit rows can carry `credential_kind` (same floor as buildFilters). */
const CREDENTIAL_KIND_SINCE = '2026-09-30T00:00:00.000000Z';

/** `yyyy-mm-ddThh:mm:ss.ffffffZ`: fixed width, so string order is time order. */
export function normalizeInstant(value: string): string {
  const fraction = /\.(\d{1,9})/.exec(value)?.[1] ?? '';
  const whole = new Date(value.replace(/\.\d+/, '')).toISOString().slice(0, 19);
  return `${whole}.${fraction.padEnd(6, '0').slice(0, 6)}Z`;
}

function likeToRegExp(pattern: string, caseInsensitive: boolean): RegExp {
  let source = '';
  for (const ch of pattern) {
    if (ch === '%') source += '.*';
    else if (ch === '_') source += '.';
    else source += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`, caseInsensitive ? 'is' : 's');
}

const text = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

export function rowMatches(row: Record<string, unknown>, accountId: string, input: AuditFilterInput): boolean {
  if (row.account_id !== accountId) return false;
  const eq = (column: string, wanted: string | null | undefined) => !wanted || text(row[column]) === wanted;
  if (!eq('actor_user_id', input.actor)) return false;
  if (!eq('project_id', input.projectId)) return false;
  if (!eq('session_id', input.sessionId)) return false;
  if (!eq('actor_type', input.actorType)) return false;
  if (!eq('authoritative_source', input.source)) return false;
  if (!eq('phase', input.phase)) return false;
  if (!eq('outcome', input.outcome)) return false;
  if (!eq('request_id', input.requestId)) return false;
  if (!eq('correlation_id', input.correlationId)) return false;
  const at = normalizeInstant(String(row.occurred_at));
  if (input.credentialKind && (text(row.credential_kind) !== input.credentialKind || at < CREDENTIAL_KIND_SINCE)) return false;

  const action = text(row.action) ?? '';
  if (input.actionPrefix) {
    const prefix = input.actionPrefix;
    const like = (value: string) => likeToRegExp(value, false).test(action);
    if (prefix === 'connector.') {
      if (!(like('connector.%') || like('computer.%'))) return false;
    } else if (prefix.includes('.') && !prefix.endsWith('.')) {
      if (!(action === prefix || like(`${prefix}.%`))) return false;
    } else if (!like(`${prefix}%`)) return false;
  }
  if (input.resourceType && !likeToRegExp(`${input.resourceType}%`, false).test(text(row.resource_type) ?? '')) return false;

  // Compare microsecond strings; a Date bound is milliseconds, like the SQL parameter.
  if (input.sinceRaw) {
    const since = new Date(input.sinceRaw);
    if (!Number.isNaN(since.getTime()) && at < normalizeInstant(since.toISOString())) return false;
  }
  if (input.untilRaw) {
    const until = new Date(input.untilRaw);
    if (!Number.isNaN(until.getTime()) && at > normalizeInstant(until.toISOString())) return false;
  }
  if (input.q) {
    const term = likeToRegExp(`%${input.q}%`, true);
    const columns = ['action', 'resource_type', 'resource_id', 'session_id', 'request_id', 'trace_id', 'correlation_id', 'project_id'];
    if (!columns.some((column) => term.test(text(row[column]) ?? ''))) return false;
  }
  return true;
}

/**
 * The in-memory twin of `buildFilters` (accounts/audit-filters.ts): the same filters, applied to
 * a row read back from the archive instead of a SQL predicate. A filter added to one must be
 * added to the other; `export-page.integration.test.ts` runs both over the same rows.
 */
import type { AuditFilterInput } from '../../../accounts/audit-filters';

/** The first day audit rows can carry `credential_kind` (same floor as buildFilters). */
const CREDENTIAL_KIND_SINCE = '2026-09-30T00:00:00.000000Z';

/** `yyyy-mm-ddThh:mm:ss.ffffffZ`: fixed width, so string order is time order. */
export function normalizeInstant(value: string): string {
  const fraction = /\.(\d{1,9})/.exec(value)?.[1] ?? '';
  const whole = new Date(value.replace(/\.\d+/, '')).toISOString().slice(0, 19);
  return `${whole}.${fraction.padEnd(6, '0').slice(0, 6)}Z`;
}

/**
 * SQL LIKE (`%` any run, `_` one character, no escape character) without building a RegExp from
 * user input: a greedy two-pointer match that backtracks only to the last `%`, so it is
 * O(value x pattern) worst case and never exponential (CodeQL/strix ReDoS, CWE-1333).
 */
export function matchesLike(value: string, pattern: string, caseInsensitive: boolean): boolean {
  const v = caseInsensitive ? value.toLowerCase() : value;
  const p = caseInsensitive ? pattern.toLowerCase() : pattern;
  let vi = 0;
  let pi = 0;
  let starP = -1;
  let starV = 0;
  while (vi < v.length) {
    if (pi < p.length && (p[pi] === '_' || (p[pi] !== '%' && p[pi] === v[vi]))) {
      vi += 1;
      pi += 1;
    } else if (pi < p.length && p[pi] === '%') {
      starP = pi;
      starV = vi;
      pi += 1;
    } else if (starP !== -1) {
      pi = starP + 1;
      starV += 1;
      vi = starV;
    } else {
      return false;
    }
  }
  while (pi < p.length && p[pi] === '%') pi += 1;
  return pi === p.length;
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
    const like = (pattern: string) => matchesLike(action, pattern, false);
    if (prefix === 'connector.') {
      if (!(like('connector.%') || like('computer.%'))) return false;
    } else if (prefix.includes('.') && !prefix.endsWith('.')) {
      if (!(action === prefix || like(`${prefix}.%`))) return false;
    } else if (!like(`${prefix}%`)) return false;
  }
  if (input.resourceType && !matchesLike(text(row.resource_type) ?? '', `${input.resourceType}%`, false)) return false;

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
    const term = `%${input.q}%`;
    const columns = ['action', 'resource_type', 'resource_id', 'session_id', 'request_id', 'trace_id', 'correlation_id', 'project_id'];
    if (!columns.some((column) => matchesLike(text(row[column]) ?? '', term, true))) return false;
  }
  return true;
}

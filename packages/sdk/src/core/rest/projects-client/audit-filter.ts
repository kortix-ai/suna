import type { ListAuditFilter } from './iam';

/**
 * The audit filter exactly as the API querystring accepts it (wire shape).
 *
 * `ListAuditFilter` is that shape for `/accounts/:id/audit`; the export
 * endpoint takes the same fields plus `format`. One builder maps this shape
 * onto the querystring for every audit read: the SDK list/export helpers and
 * the host-boundary export download. Internal by intent — not re-exported
 * from any public barrel (like `./shared`), so the `@kortix/sdk` surface is
 * unchanged.
 */

/** Map the wire filter onto the querystring, omitting unset and empty
 *  values. Field order follows the filter object's key order; the SDK
 *  builders construct it in the canonical order. */
export function auditFilterQuery(filter: ListAuditFilter & { format?: 'csv' | 'jsonl' }): URLSearchParams {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) {
    if (value != null && value !== '') search.set(key, String(value));
  }
  return search;
}

import type { ListAuditFilter } from './iam';

/** Only the audit endpoint's supported wire fields reach the URL. */
export function auditFilterQuery(
  filter: ListAuditFilter & { format?: 'csv' | 'jsonl' },
): URLSearchParams {
  const search = new URLSearchParams();
  const keys =
    ' format action actor actor_type project_id session_id source credential_kind phase outcome resource_type request_id correlation_id since until q cursor limit ';
  for (const [key, value] of Object.entries(filter)) {
    if (keys.includes(` ${key} `) && value != null && value !== '') search.set(key, String(value));
  }
  return search;
}

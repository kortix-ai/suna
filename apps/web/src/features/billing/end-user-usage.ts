import type { UsageBreakdownItem } from '@kortix/sdk';

export interface EndUserUsageRow {
  originRef: string;
  cost: number;
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  /** Share of the listed spend, 0–1. 0 when nothing was spent at all. */
  share: number;
}

/**
 * Shape a `group_by=origin_ref` breakdown into rows for the end-user spend table.
 *
 * Only rows that actually carry an `origin_ref` are end-users of a
 * Kortix-as-a-Backend wrapper. Everything else — interactive dashboard sessions,
 * and any event written before the column existed — has none, and must not be
 * folded into an end-user's bill or shown as a blank row. Sorted by spend so the
 * expensive end-user is the first thing read.
 */
export function toEndUserUsageRows(breakdown: UsageBreakdownItem[] | undefined): EndUserUsageRow[] {
  // Read either spelling: `end_user_ref` is the name, `origin_ref` the
  // deprecated alias an older server may still be the only one sending.
  const attributed = (breakdown ?? [])
    .map((item) => ({ item, ref: item.end_user_ref ?? item.origin_ref }))
    .filter(
      (entry): entry is { item: UsageBreakdownItem; ref: string } =>
        typeof entry.ref === 'string' && entry.ref.length > 0,
    )
    .map((entry) => ({ ...entry.item, origin_ref: entry.ref }));
  const total = attributed.reduce((sum, item) => sum + (item.cost ?? 0), 0);
  return attributed
    .map((item) => ({
      originRef: item.origin_ref,
      cost: item.cost ?? 0,
      sessions: item.count ?? 0,
      inputTokens: item.input_tokens ?? 0,
      outputTokens: item.output_tokens ?? 0,
      share: total > 0 ? (item.cost ?? 0) / total : 0,
    }))
    .sort((a, b) => b.cost - a.cost || a.originRef.localeCompare(b.originRef));
}

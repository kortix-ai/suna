/**
 * Pure query-parsing and row → response mapping for `GET /v1/usage`.
 * Deliberately has NO DB/config imports so it can be unit-tested without
 * booting the API's env validation (see usage.test.ts) — the route handler
 * in ./usage.ts is the only place this is wired to the live `usage_events`
 * aggregation query.
 */

export type UsageGroupBy = 'model' | 'provider' | 'day';

const USAGE_GROUP_BY_VALUES: readonly UsageGroupBy[] = ['model', 'provider', 'day'];

export interface UsageQueryParams {
  start?: Date;
  end?: Date;
  groupBy?: UsageGroupBy;
}

export class InvalidUsageQueryError extends Error {}

/** Parses + validates the `GET /v1/usage` query params (`start`, `end`, `group_by`). */
export function parseUsageQuery(query: {
  start?: string;
  end?: string;
  group_by?: string;
}): UsageQueryParams {
  const result: UsageQueryParams = {};

  if (query.start !== undefined && query.start !== '') {
    const start = new Date(query.start);
    if (Number.isNaN(start.getTime())) {
      throw new InvalidUsageQueryError(`Invalid start timestamp: ${query.start}`);
    }
    result.start = start;
  }

  if (query.end !== undefined && query.end !== '') {
    const end = new Date(query.end);
    if (Number.isNaN(end.getTime())) {
      throw new InvalidUsageQueryError(`Invalid end timestamp: ${query.end}`);
    }
    result.end = end;
  }

  if (result.start && result.end && result.start.getTime() > result.end.getTime()) {
    throw new InvalidUsageQueryError('start must not be after end');
  }

  if (query.group_by !== undefined && query.group_by !== '') {
    if (!USAGE_GROUP_BY_VALUES.includes(query.group_by as UsageGroupBy)) {
      throw new InvalidUsageQueryError(
        `group_by must be one of: ${USAGE_GROUP_BY_VALUES.join(', ')}`,
      );
    }
    result.groupBy = query.group_by as UsageGroupBy;
  }

  return result;
}

export interface UsageTotalsRow {
  totalInputTokens: number | string | null;
  totalOutputTokens: number | string | null;
  totalCachedTokens: number | string | null;
  totalCost: number | string | null;
  count: number | string | null;
}

/** Maps the aggregate totals row (or `undefined` for a zero-row window) to the `data` envelope. */
export function mapUsageTotals(row: UsageTotalsRow | undefined) {
  return {
    total_input_tokens: Number(row?.totalInputTokens ?? 0),
    total_output_tokens: Number(row?.totalOutputTokens ?? 0),
    total_cached_tokens: Number(row?.totalCachedTokens ?? 0),
    total_cost: Number(row?.totalCost ?? 0),
    count: Number(row?.count ?? 0),
  };
}

export interface UsageBreakdownRow {
  day?: string | null;
  provider?: string | null;
  model?: string | null;
  inputTokens: number | string | null;
  outputTokens: number | string | null;
  cachedTokens: number | string | null;
  cost: number | string | null;
  count: number | string | null;
}

/**
 * Maps one grouped aggregate row to a `breakdown[]` entry — the row shape
 * (and therefore the output shape) depends on which `group_by` produced it.
 */
export function mapUsageBreakdownRow(row: UsageBreakdownRow) {
  const totals = {
    input_tokens: Number(row.inputTokens ?? 0),
    output_tokens: Number(row.outputTokens ?? 0),
    cached_tokens: Number(row.cachedTokens ?? 0),
    cost: Number(row.cost ?? 0),
    count: Number(row.count ?? 0),
  };
  if (row.day !== undefined) {
    return { day: row.day, ...totals };
  }
  if (row.model !== undefined) {
    return { provider: row.provider ?? null, model: row.model, ...totals };
  }
  return { provider: row.provider ?? null, ...totals };
}

export class InvalidCostQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCostQueryError';
  }
}

export interface CostWindow {
  from: Date;
  to: Date;
}

export type CostSort = 'total_desc' | 'total_asc' | 'recent' | 'name_asc';

export const MAX_COST_OFFSET = 10_000;
export const MAX_COST_LIMIT = 100;
const DEFAULT_WINDOW_DAYS = 30;
const MAX_WINDOW_DAYS = 366;
const DAY_MS = 86_400_000;

function parseBound(value: string, name: 'from' | 'to'): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new InvalidCostQueryError(`${name} must be an ISO 8601 timestamp`);
  }
  return parsed;
}

// Windows are half-open [from, to) and always UTC. Absent bounds default to the
// trailing 30 days so a bare request is cheap rather than account-lifetime wide.
export function parseCostWindow(input: { from?: string; to?: string }): CostWindow {
  const to = input.to ? parseBound(input.to, 'to') : new Date();
  const from = input.from
    ? parseBound(input.from, 'from')
    : new Date(to.getTime() - DEFAULT_WINDOW_DAYS * DAY_MS);

  if (from.getTime() >= to.getTime()) {
    throw new InvalidCostQueryError('from must be earlier than to');
  }
  if (to.getTime() - from.getTime() > MAX_WINDOW_DAYS * DAY_MS) {
    throw new InvalidCostQueryError(`the window must not exceed ${MAX_WINDOW_DAYS} days`);
  }
  return { from, to };
}

export function parseCostSort(
  value: string | undefined,
  allowed: readonly CostSort[],
  fallback: CostSort,
): CostSort {
  if (!value) return fallback;
  if (!allowed.includes(value as CostSort)) {
    throw new InvalidCostQueryError(`sort must be one of: ${allowed.join(', ')}`);
  }
  return value as CostSort;
}

function parseInteger(value: string | undefined, name: 'limit' | 'offset'): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) {
    throw new InvalidCostQueryError(`${name} must be an integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new InvalidCostQueryError(`${name} must be a safe integer`);
  }
  return parsed;
}

export function parseCostPagination(input: { limit?: string; offset?: string }): {
  limit: number;
  offset: number;
} {
  const limit = parseInteger(input.limit, 'limit') ?? 25;
  const offset = parseInteger(input.offset, 'offset') ?? 0;

  if (limit < 1 || limit > MAX_COST_LIMIT) {
    throw new InvalidCostQueryError(`limit must be an integer from 1 to ${MAX_COST_LIMIT}`);
  }
  // Deep OFFSET on a sorted aggregate is O(offset). Cap it rather than let a
  // crafted query walk the whole table.
  if (offset > MAX_COST_OFFSET) {
    throw new InvalidCostQueryError(`offset must not exceed ${MAX_COST_OFFSET}`);
  }
  return { limit, offset };
}

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

// A date-only ISO string (YYYY-MM-DD) is unambiguous: the ECMAScript spec
// defines it as UTC midnight regardless of the parsing environment's local
// time zone.
const ISO_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
// A full date-time is only unambiguous with an explicit UTC designator (Z/z)
// or a numeric offset — both pin the string to one instant. Per spec, a
// date-time with neither parses as *local* time, which would silently
// violate the "always UTC" window contract depending on server TZ (e.g.
// `new Date('2026-07-01T00:00:00.000')` under TZ=Asia/Calcutta becomes
// 2026-06-30T18:30:00.000Z, not the UTC midnight the caller wrote).
const ISO_DATE_TIME_WITH_DESIGNATOR =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|z|[+-]\d{2}:\d{2})$/;

function parseBound(value: string, name: 'from' | 'to'): Date {
  const invalidMessage = `${name} must be an ISO 8601 timestamp with a UTC designator or offset (e.g. 2026-07-01T00:00:00Z)`;
  const isUnambiguousInstant =
    ISO_DATE_ONLY.test(value) || ISO_DATE_TIME_WITH_DESIGNATOR.test(value);
  if (!isUnambiguousInstant) {
    throw new InvalidCostQueryError(invalidMessage);
  }
  const parsed = new Date(value);
  // The regex accepts the shape but not the range (e.g. month 13), so a
  // second check still catches a well-formed-looking but invalid date.
  if (Number.isNaN(parsed.getTime())) {
    throw new InvalidCostQueryError(invalidMessage);
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

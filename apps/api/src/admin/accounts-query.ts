/**
 * Pure parsing for the admin accounts-list query string.
 *
 * Kept separate from the route handler so the filter semantics (which the web
 * admin console depends on — paid-only, payment status, has-subscription, tier,
 * balance, sort, pagination) are unit-testable without spinning up Drizzle.
 */

/** Tiers that do NOT count as "paid". Mirrors isPaidTier() in billing/services/tiers.ts. */
export const UNPAID_TIERS = ['free', 'none'] as const;

export type AdminAccountsSortBy = 'created' | 'balance' | 'name';
export type AdminAccountsSortDir = 'asc' | 'desc';

export interface AdminAccountsListQuery {
  search: string;
  tierValues: string[];
  paymentStatusValues: string[];
  paidOnly: boolean;
  /** true → only with a subscription, false → only without, null → no filter. */
  hasSubscription: boolean | null;
  minBalance: string | null;
  maxBalance: string | null;
  sortBy: AdminAccountsSortBy;
  sortDir: AdminAccountsSortDir;
  page: number;
  limit: number;
  offset: number;
}

function csv(value: string | undefined | null): string[] {
  return (value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function intIn(value: string | undefined | null, fallback: number, min: number, max: number): number {
  const n = parseInt(value || '', 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Parse the raw query into a normalized filter intent.
 *
 * @param get accessor over the request query (e.g. `(k) => c.req.query(k)`)
 */
export function parseAdminAccountsListQuery(
  get: (key: string) => string | undefined,
): AdminAccountsListQuery {
  const sortByRaw = get('sortBy');
  const sortBy: AdminAccountsSortBy =
    sortByRaw === 'balance' || sortByRaw === 'name' ? sortByRaw : 'created';

  const hasSubRaw = get('hasSubscription');
  const hasSubscription = hasSubRaw === 'true' ? true : hasSubRaw === 'false' ? false : null;

  const page = intIn(get('page'), 1, 1, Number.MAX_SAFE_INTEGER);
  const limit = intIn(get('limit'), 50, 1, 100);

  const minBalanceRaw = get('minBalance');
  const maxBalanceRaw = get('maxBalance');

  return {
    search: (get('search') || '').trim(),
    tierValues: csv(get('tier')),
    paymentStatusValues: csv(get('paymentStatus')),
    paidOnly: get('paid') === 'true',
    hasSubscription,
    minBalance: minBalanceRaw && minBalanceRaw.length ? minBalanceRaw : null,
    maxBalance: maxBalanceRaw && maxBalanceRaw.length ? maxBalanceRaw : null,
    sortBy,
    sortDir: get('sortDir') === 'asc' ? 'asc' : 'desc',
    page,
    limit,
    offset: (page - 1) * limit,
  };
}

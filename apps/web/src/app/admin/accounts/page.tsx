'use client';

import {
  ArrowDownRightIcon as ArrowDownRight,
  ArrowUpRightIcon as ArrowUpRight,
  ProhibitIcon as Ban,
  CheckCircleIcon as CheckCircle2,
  CheckIcon,
  CopyIcon,
  CreditCardIcon as CreditCard,
  ArrowSquareOutIcon as ExternalLink,
  EyeIcon as Eye,
  FunnelIcon as Filter,
  KanbanIcon as FolderKanban,
  ClockCounterClockwiseIcon as History,
  IdentificationCardIcon,
  KeyIcon as Key,
  EnvelopeIcon as Mail,
  ShieldIcon as Shield,
  SlidersHorizontalIcon as SlidersHorizontal,
  UsersIcon as Users,
  XIcon as X,
} from '@phosphor-icons/react';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import Hint from '@/components/ui/hint';
import { Input } from '@/components/ui/input';
import { IconInbox } from '@/components/ui/kortix-icons';
import Loading from '@/components/ui/loading';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { errorToast, successToast } from '@/components/ui/toast';
import { CreditTransactionsTable } from '@/features/billing/transactions-table';
import { EmptyState } from '@/features/layout/section/empty-state';
import {
  useAdminAccount,
  useAdminAccountLedger,
  useAdminAccountProjects,
  useAdminAccountSubscription,
  useAdminAccountUsers,
  useAdminAccounts,
  useAdminDebitCredits,
  useAdminGrantCredits,
  useAdminGrantTrial,
  useAdminImpersonate,
  useAdminRevokeTrial,
  useAdminSetEnterpriseDemo,
  useAdminSetEnterpriseEntitled,
  useAdminSetManagedModels,
  useAdminSetMemberRole,
  useAdminSetOverrides,
  type AdminAccount,
  type AdminAccountMemberRole,
  type AdminAccountsFilters,
  type AdminAccountsSortBy,
  type AdminAccountsSortDir,
} from '@/hooks/admin/use-admin-accounts';
import { useDebounce } from '@/hooks/use-debounced-value';
import { clearLastProjectId } from '@/lib/onboarding/last-project-cookie';
import { cn } from '@/lib/utils';

import { AdminPageShell, AdminRefreshButton } from '../_components/admin-page-shell';
import { AdminEmptyFrame, AdminTableFrame } from '../_components/admin-panel';
import { AdminPagination, AdminSearch, AdminSortHeader } from '../_components/admin-table';
import { StatGrid, StatTile } from '../_components/stat-tile';
import { adminLedgerRows } from './ledger-rows';
import {
  MAX_COMPUTE_RATE_MULTIPLIER,
  MAX_CONCURRENT_SESSIONS_OVERRIDE,
  describeOverridePatch,
  draftFromOverrides,
  isEmptyPatch,
  isOverrideExpired,
  overrideExpiresAt,
  overridesPatch,
  type BooleanOverrideKey,
  type OverrideTriState,
  type OverridesDraft,
} from './overrides-form';

const PAGE_SIZE = 50;
const REIMBURSEMENT_PRESETS = [5, 10, 25, 50, 100];

// Tier FILTER options — and nothing else.
//
// The `value`s are raw `credit_accounts.tier` keys because the list route
// filters on that stored column server-side (`inArray(creditAccounts.tier, …)`
// in apps/api/src/admin/index.ts), so this list has to keep spelling the keys
// exactly. The LABELS are the only thing this page still names by hand, and
// they name a KEY, never an account: what an account's plan is comes from the
// API's resolved `plan` block (see `PlanBadge` below), which is the same
// resolver every server gate uses. The page used to re-derive that from the
// key and stamp its own suffix onto it, which is exactly how this file's plan
// vocabulary drifted away from the server's.
//
// `grandfathered` groups the keys that were sold once and are still honored
// exactly as sold; the price disambiguates the repeated product names (there
// are two "Pro"s at different prices). Order and prices follow PLAN_CATALOG in
// apps/api/src/billing/services/plan-catalog.ts.
type TierFilterOption = { value: string; label: string; grandfathered?: boolean };
const TIER_OPTIONS: TierFilterOption[] = [
  { value: 'none', label: 'No plan' },
  { value: 'free', label: 'Free' },
  { value: 'starter', label: 'Starter' },
  { value: 'team', label: 'Team' },
  { value: 'scale', label: 'Scale' },
  { value: 'enterprise', label: 'Enterprise' },
  { value: 'pro', label: 'Pro · $20/mo', grandfathered: true },
  { value: 'tier_2_20', label: 'Plus · $20/mo', grandfathered: true },
  { value: 'per_seat', label: 'Team · $40/seat/mo', grandfathered: true },
  { value: 'tier_6_50', label: 'Pro · $50/mo', grandfathered: true },
  { value: 'tier_12_100', label: 'Business · $100/mo', grandfathered: true },
  { value: 'tier_25_200', label: 'Ultra · $200/mo', grandfathered: true },
  { value: 'tier_50_400', label: 'Enterprise · $400/mo', grandfathered: true },
  { value: 'tier_125_800', label: 'Scale · $800/mo', grandfathered: true },
  { value: 'tier_200_1000', label: 'Max · $1,000/mo', grandfathered: true },
  { value: 'tier_150_1200', label: 'Enterprise Max · $1,200/mo', grandfathered: true },
];

const TIER_LABELS: Record<string, string> = Object.fromEntries(
  TIER_OPTIONS.map((t) => [t.value, t.label]),
);

const PAYMENT_STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: 'active', label: 'Active' },
  { value: 'past_due', label: 'Past due' },
  { value: 'canceled', label: 'Canceled' },
  { value: 'unpaid', label: 'Unpaid' },
  { value: 'incomplete', label: 'Incomplete' },
  { value: 'trialing', label: 'Trialing' },
];

function formatCredits(value: string | number | null | undefined) {
  const n = Number(value ?? 0);
  const amount = Number.isFinite(n) ? n : 0;
  const sign = amount < 0 ? '-' : '';
  return `${sign}$${Math.abs(amount).toFixed(2)}`;
}

/** Short form: always $X.XX, no sign logic (caller adds + / -). */
function money(value: string | number | null | undefined) {
  const n = Number(value ?? 0);
  return `$${(Number.isFinite(n) ? Math.abs(n) : 0).toFixed(2)}`;
}

function stripeUrl(kind: 'customer' | 'subscription', id: string): string {
  const isTest = id.startsWith('cus_test_') || id.startsWith('sub_test_');
  const base = `https://dashboard.stripe.com${isTest ? '/test' : ''}`;
  return `${base}/${kind === 'customer' ? 'customers' : 'subscriptions'}/${id}`;
}

function revenuecatSearchUrl(email: string | null): string {
  if (!email) return 'https://app.revenuecat.com/customers';
  return `https://app.revenuecat.com/customers?search=${encodeURIComponent(email)}`;
}

/**
 * The name to show for an account — the same one the customer sees.
 *
 * `account.name` is the raw stored column; for rows created before named
 * accounts it is a migration placeholder ('Personal' / 'User') that every
 * customer-facing surface maps to "<owner email>'s Account". The server now
 * ships that resolved name as `displayName`; this falls back to the raw column
 * for a console pointed at an older API.
 */
function accountLabelFor(account: AdminAccount): string {
  return account.displayName || account.name || 'Unnamed account';
}

interface BillingAction {
  label: string;
  href: string;
  domain: string;
}

function faviconUrl(domain: string, size = 32): string {
  return `https://www.google.com/s2/favicons?domain=${domain}&sz=${size}`;
}

function ServiceFavicon({ domain, className }: { domain: string; className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={faviconUrl(domain, 64)}
      alt=""
      aria-hidden
      width={14}
      height={14}
      className={cn('h-3.5 w-3.5 shrink-0 rounded-sm', className)}
    />
  );
}

function billingActionsFor(account: AdminAccount): BillingAction[] {
  const actions: BillingAction[] = [];
  if (account.stripeSubscriptionId?.startsWith('sub_')) {
    actions.push({
      label: 'Subscription in Stripe',
      href: stripeUrl('subscription', account.stripeSubscriptionId),
      domain: 'stripe.com',
    });
  }
  if (account.billingCustomerId?.startsWith('cus_')) {
    actions.push({
      label: 'Customer in Stripe',
      href: stripeUrl('customer', account.billingCustomerId),
      domain: 'stripe.com',
    });
  }
  if (account.provider?.toLowerCase() === 'revenuecat') {
    actions.push({
      label: 'Search in RevenueCat',
      href: revenuecatSearchUrl(account.billingCustomerEmail || account.ownerEmail),
      domain: 'revenuecat.com',
    });
  }
  return actions;
}

const dateTimeFormat = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

const createdAtFormat = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

function formatDateTime(value: string | null | undefined) {
  if (!value) return '—';
  return dateTimeFormat.format(new Date(value));
}

/**
 * Label for a raw tier KEY — filter chips, and the trial tiers, which are keys
 * an operator picked rather than a plan an account resolved to. Falls through
 * to the key itself so an unknown key is visible instead of silently renamed.
 *
 * NOT for "what plan is this account on?" — that is `PlanBadge` / `planLabel`.
 */
function tierKeyLabel(tier: string | null | undefined): string {
  if (!tier) return 'No plan';
  return TIER_LABELS[tier] ?? tier;
}

/**
 * The plan the account BEHAVES as, straight off the API's resolved `plan`
 * block: an active admin trial and the per-seat self-heal overlay the stored
 * `tier` column, and the resolver applies the same precedence every gate does.
 * The stored key stays available as `account.tier` for the filter.
 *
 * The fallback covers a console pointed at an API older than the resolver.
 */
function planLabel(account: AdminAccount): string {
  return account.plan?.label ?? tierKeyLabel(account.tier);
}

function planBadgeVariant(account: AdminAccount): React.ComponentProps<typeof Badge>['variant'] {
  const family = account.plan?.family ?? (isUnpaidTierKey(account.tier) ? 'free' : 'team');
  return family === 'free' ? 'muted' : 'info';
}

/** `free` and `none` are the only two keys in the free family (UNPAID_TIERS in
 *  apps/api/src/admin/accounts-query.ts). */
function isUnpaidTierKey(tier: string | null): boolean {
  return !tier || tier === 'free' || tier === 'none';
}

/**
 * Plan name plus its qualifier — e.g. "Team · $40/seat/mo · grandfathered".
 * The qualifier is the server's, not a claim this page invents from the key.
 */
function PlanBadge({
  account,
  size = 'sm',
  className,
}: {
  account: AdminAccount;
  size?: React.ComponentProps<typeof Badge>['size'];
  className?: string;
}) {
  const sublabel = account.plan?.sublabel;
  return (
    <Badge variant={planBadgeVariant(account)} size={size} className={className}>
      {planLabel(account)}
      {sublabel ? <span className="ml-1 font-normal opacity-70">· {sublabel}</span> : null}
    </Badge>
  );
}

/**
 * What Stripe ACTUALLY charges, next to the plan badge.
 *
 * The badge describes the STORED tier: a grandfathered `pro` row renders
 * "Team · $20/mo · grandfathered" even when the live subscription is a $40/mo
 * "Kortix Computer" machine sub. An operator reading only the badge mis-priced
 * the customer. Renders nothing while loading, and nothing when the account has
 * no subscription on file — the badge alone is correct in that case.
 */
function LiveSubscriptionLine({ accountId }: { accountId: string }) {
  const { data, error } = useAdminAccountSubscription(accountId);
  const sub = data?.subscription;
  // A lookup that FAILS is itself the finding: the account row carries a
  // subscription id Stripe does not know (stale/rotated/wrong Stripe account).
  // Swallowing it would render the same blank line as "no subscription".
  if (error) {
    return (
      <span className="text-destructive flex items-center gap-1.5 text-xs">
        <CreditCard className="h-3 w-3 shrink-0" />
        <span className="truncate">Stripe lookup failed: {error.message}</span>
      </span>
    );
  }
  if (!sub) return null;
  const amount =
    sub.totalAmountUsd != null
      ? `${money(sub.totalAmountUsd)}${sub.interval ? `/${sub.interval}` : ''}`
      : null;
  const label = sub.description || sub.productName;
  return (
    <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
      <CreditCard className="h-3 w-3 shrink-0" />
      <span className="truncate">
        Stripe charges {amount ?? 'an unknown amount'}
        {sub.quantity > 1 ? ` (${sub.quantity}×)` : ''}
        {label ? ` · ${label}` : ''}
        {sub.status !== 'active' ? ` · ${sub.status.replace(/_/g, ' ')}` : ''}
      </span>
    </span>
  );
}

// ── Trial helpers ────────────────────────────────────────────────────────────
// `active` is the only status that grants the trial tier. The other four are
// history the row keeps for audit, so they render greyed rather than hidden.

/**
 * Trial tiers offered in the grant form. Deliberately TWO, not the whole
 * catalog: model access is the independent "Managed models" switch below (not
 * a tier property), so the only real choice is whether the trial carries the
 * enterprise identity surface. The API accepts any paid tier for edge cases;
 * `free`/`none` are rejected server-side.
 */
const TRIAL_TIER_OPTIONS: { value: string; label: string; hint: string }[] = [
  { value: 'team', label: 'Team', hint: 'Standard paid plan — recommended' },
  { value: 'enterprise', label: 'Enterprise', hint: 'Adds SSO, SCIM, RBAC, audit log' },
];

const TRIAL_DURATION_PRESETS = [14, 30, 60, 90];
const MAX_TRIAL_SEATS = 100; // MAX_SEATS_PER_ACCOUNT in billing/services/tiers.ts
const MAX_TRIAL_DURATION_DAYS = 365; // MAX_TRIAL_DURATION_DAYS in billing/services/trial-admin.ts
const MAX_TRIAL_CREDIT_GRANT = 10_000;

function trialIsActive(trial: AdminAccount['trial'] | undefined): boolean {
  return trial?.status === 'active';
}

function trialBadgeVariant(status: string | null): React.ComponentProps<typeof Badge>['variant'] {
  switch (status) {
    case 'active':
      return 'success';
    case 'converted':
      return 'info';
    case 'revoked':
      return 'destructive';
    case 'expired':
      return 'warning';
    default:
      return 'muted';
  }
}

/**
 * Signed relative distance. `formatRelative` collapses any negative diff to
 * "just now", which would print an active trial's future end date as "just now".
 */
function formatCountdown(value: string | null): string {
  if (!value) return '—';
  const ms = new Date(value).getTime() - Date.now();
  if (!Number.isFinite(ms)) return '—';
  const abs = Math.abs(ms);
  // Round, don't floor: a 90-day window read a millisecond after it is issued
  // is 89.999 days, and "in 89d" for a trial the operator just set to 90 reads
  // as an off-by-one bug.
  const unit =
    abs < 3_600_000
      ? `${Math.max(1, Math.round(abs / 60_000))}m`
      : abs < 86_400_000
        ? `${Math.round(abs / 3_600_000)}h`
        : `${Math.round(abs / 86_400_000)}d`;
  return ms < 0 ? `${unit} ago` : `in ${unit}`;
}

function paymentStatusBadge(status: string | null): React.ComponentProps<typeof Badge>['variant'] {
  if (!status) return 'muted';
  switch (status) {
    case 'active':
    case 'trialing':
      return 'success';
    case 'past_due':
    case 'incomplete':
      return 'warning';
    case 'canceled':
    case 'unpaid':
      return 'destructive';
    default:
      return 'muted';
  }
}

type AccountFilters = Required<
  Pick<
    AdminAccountsFilters,
    'search' | 'tier' | 'paymentStatus' | 'paidOnly' | 'sortBy' | 'sortDir'
  >
> & {
  hasSubscription: boolean | null;
  minBalance: number | null;
  maxBalance: number | null;
};

const EMPTY_FILTERS: AccountFilters = {
  search: '',
  tier: [],
  paymentStatus: [],
  paidOnly: false,
  hasSubscription: null,
  minBalance: null,
  maxBalance: null,
  sortBy: 'created',
  sortDir: 'desc',
};

function activeFilterCount(f: AccountFilters): number {
  let n = 0;
  if (f.paidOnly) n += 1;
  if (f.tier.length) n += 1;
  if (f.paymentStatus.length) n += 1;
  if (f.hasSubscription !== null) n += 1;
  if (f.minBalance !== null) n += 1;
  if (f.maxBalance !== null) n += 1;
  return n;
}

export default function AdminAccountsPage() {
  // Seed from ?search= so cross-links (e.g. the Projects page's account cell)
  // land on a filtered list instead of the whole fleet.
  const urlSearchParams = useSearchParams();
  const [searchInput, setSearchInput] = useState(() => urlSearchParams.get('search') ?? '');
  const search = useDebounce(searchInput);
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<AccountFilters>(EMPTY_FILTERS);
  const [selected, setSelected] = useState<AdminAccount | null>(null);

  useEffect(() => {
    setPage(1);
  }, [
    search,
    filters.paidOnly,
    filters.tier.length,
    filters.paymentStatus.length,
    filters.hasSubscription,
    filters.minBalance,
    filters.maxBalance,
    filters.sortBy,
    filters.sortDir,
  ]);

  const { data, isLoading, isFetching, refetch } = useAdminAccounts({
    ...filters,
    search,
    page,
    limit: PAGE_SIZE,
  });

  const accounts = data?.accounts ?? [];
  const total = data?.total ?? 0;
  const summary = data?.summary ?? null;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const filtersCount = activeFilterCount(filters);

  // `selected` is the row object captured at click time. The live source is
  // the exact-id lookup (immune to the list's filters — a mutation that pushes
  // the row out of a filtered list no longer strands the sheet on a
  // pre-mutation snapshot); the filtered list row and the click-time snapshot
  // are fallbacks while the lookup loads.
  const selectedDetail = useAdminAccount(selected?.accountId ?? null);
  const selectedAccount = selected
    ? (selectedDetail.data ?? accounts.find((a) => a.accountId === selected.accountId) ?? selected)
    : null;

  const setSort = useCallback((sortBy: AdminAccountsSortBy) => {
    setFilters((f) => {
      if (f.sortBy === sortBy) {
        return { ...f, sortDir: f.sortDir === 'asc' ? 'desc' : 'asc' };
      }
      return { ...f, sortBy, sortDir: 'desc' };
    });
  }, []);

  const resetFilters = () => {
    setFilters(EMPTY_FILTERS);
    setSearchInput('');
  };

  return (
    <AdminPageShell
      width="wide"
      title="Accounts"
      description="Filter, sort and inspect every account. Grant or debit credits, read the ledger, and see billing state."
      action={<AdminRefreshButton busy={isFetching} onRefresh={() => void refetch()} />}
    >
      <StatGrid>
        <StatTile
          label="Total (filtered)"
          value={total.toLocaleString()}
          hint={filtersCount > 0 ? 'Matches the current filters' : 'All accounts'}
        />
        <StatTile
          label="Paid"
          value={(summary?.paidCount ?? 0).toLocaleString()}
          tone="success"
          hint="Non-free tiers"
        />
        <StatTile
          label="Credits in set"
          value={formatCredits(summary?.totalCredits ?? 0)}
          hint="Sum of balances"
        />
        <StatTile
          label="Past due"
          value={summary?.pastDueCount ?? 0}
          tone={(summary?.pastDueCount ?? 0) > 0 ? 'warning' : 'default'}
          hint={(summary?.pastDueCount ?? 0) > 0 ? 'Needs review' : 'All clear'}
        />
      </StatGrid>

      <FilterBar
        searchInput={searchInput}
        onSearchChange={setSearchInput}
        filters={filters}
        onFiltersChange={setFilters}
        onReset={resetFilters}
        filtersCount={filtersCount}
      />

      <ActiveChips
        filters={filters}
        onChange={setFilters}
        searchInput={searchInput}
        onSearchChange={setSearchInput}
      />

      {isLoading ? (
        <div className="space-y-2">
          {[...Array(8)].map((_, i) => (
            <Skeleton key={i} className="h-12 w-full rounded-md" />
          ))}
        </div>
      ) : accounts.length === 0 ? (
        <AdminEmptyFrame>
          <EmptyState
            icon={IconInbox}
            size="sm"
            title={
              search || filtersCount > 0 ? 'No accounts match these filters' : 'No accounts yet'
            }
            description={
              search || filtersCount > 0
                ? 'Try adjusting the filters or clearing the search.'
                : undefined
            }
            action={
              search || filtersCount > 0 ? (
                <Button variant="outline" size="sm" onClick={resetFilters}>
                  Clear filters
                </Button>
              ) : undefined
            }
          />
        </AdminEmptyFrame>
      ) : (
        <AdminTableFrame busy={isFetching}>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <SortHeader
                  label="Account"
                  column="name"
                  sortBy={filters.sortBy}
                  sortDir={filters.sortDir}
                  onSort={setSort}
                />
                <TableHead>Plan</TableHead>
                <SortHeader
                  label="Balance"
                  column="balance"
                  sortBy={filters.sortBy}
                  sortDir={filters.sortDir}
                  onSort={setSort}
                  align="right"
                />
                <SortHeader
                  label="Members"
                  column="members"
                  sortBy={filters.sortBy}
                  sortDir={filters.sortDir}
                  onSort={setSort}
                  align="right"
                />
                <TableHead>Status</TableHead>
                <SortHeader
                  label="Created"
                  column="created"
                  sortBy={filters.sortBy}
                  sortDir={filters.sortDir}
                  onSort={setSort}
                />
              </TableRow>
            </TableHeader>
            <TableBody>
              {accounts.map((account) => (
                <TableRow
                  key={account.accountId}
                  className="cursor-pointer"
                  onClick={() => setSelected(account)}
                >
                  <TableCell>
                    <div className="max-w-[320px] min-w-0">
                      <div className="truncate text-sm font-medium">{accountLabelFor(account)}</div>
                      <div className="text-muted-foreground truncate text-xs">
                        {account.ownerEmail || 'No owner email'}
                        <span className="text-muted-foreground/40 mx-1.5">·</span>
                        <span className="font-mono">{account.accountId.slice(0, 8)}</span>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <PlanBadge account={account} />
                  </TableCell>
                  <TableCell className="text-right">
                    <span
                      className={cn(
                        'font-mono text-sm',
                        Number(account.balance ?? 0) < 0 && 'text-kortix-red',
                      )}
                    >
                      {formatCredits(account.balance)}
                    </span>
                  </TableCell>
                  <TableCell className="text-right text-sm tabular-nums">
                    {account.memberCount}
                  </TableCell>
                  <TableCell>
                    {account.paymentStatus ? (
                      <Badge
                        variant={paymentStatusBadge(account.paymentStatus)}
                        size="sm"
                        className="capitalize"
                      >
                        {account.paymentStatus.replace(/_/g, ' ')}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground text-xs">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {account.createdAt ? createdAtFormat.format(new Date(account.createdAt)) : '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </AdminTableFrame>
      )}

      <AdminPagination
        page={page}
        pages={pages}
        total={total}
        noun="accounts"
        onPageChange={setPage}
      />

      <AccountDetailSheet account={selectedAccount} onClose={() => setSelected(null)} />
    </AdminPageShell>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Filter bar
// ─────────────────────────────────────────────────────────────────────────────

function FilterBar({
  searchInput,
  onSearchChange,
  filters,
  onFiltersChange,
  onReset,
  filtersCount,
}: {
  searchInput: string;
  onSearchChange: (v: string) => void;
  filters: AccountFilters;
  onFiltersChange: (f: AccountFilters) => void;
  onReset: () => void;
  filtersCount: number;
}) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <AdminSearch
          value={searchInput}
          onChange={onSearchChange}
          placeholder="Search accounts, owner emails, IDs"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="border-input bg-popover flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm">
          <Switch
            checked={filters.paidOnly}
            onCheckedChange={(v) => onFiltersChange({ ...filters, paidOnly: v })}
            aria-label={'Paid accounts only'}
          />
          <span className="text-sm">{'Paid only'}</span>
        </label>

        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm">
              <Filter className="h-3.5 w-3.5" />
              Filters
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-[320px] p-0">
            <FiltersPanel filters={filters} onChange={onFiltersChange} onReset={onReset} />
          </PopoverContent>
        </Popover>

        <Select
          value={`${filters.sortBy}:${filters.sortDir}`}
          onValueChange={(v) => {
            const [sortBy, sortDir] = v.split(':') as [AdminAccountsSortBy, AdminAccountsSortDir];
            onFiltersChange({ ...filters, sortBy, sortDir });
          }}
        >
          <SelectTrigger variant="outline" size="sm" arrow={false}>
            <SlidersHorizontal className="text-muted-foreground h-3.5 w-3.5" />
            <SelectValue placeholder="Sort" />
          </SelectTrigger>
          <SelectContent align="end">
            <SelectItem value="created:desc">{'Newest first'}</SelectItem>
            <SelectItem value="created:asc">{'Oldest first'}</SelectItem>
            <SelectItem value="balance:desc">{'Balance — high'}</SelectItem>
            <SelectItem value="balance:asc">{'Balance — low'}</SelectItem>
            <SelectItem value="members:desc">{'Most members'}</SelectItem>
            <SelectItem value="members:asc">{'Fewest members'}</SelectItem>
            <SelectItem value="name:asc">{'Name A–Z'}</SelectItem>
            <SelectItem value="name:desc">{'Name Z–A'}</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

function FiltersPanel({
  filters,
  onChange,
  onReset,
}: {
  filters: AccountFilters;
  onChange: (f: AccountFilters) => void;
  onReset: () => void;
}) {
  const [minBalance, setMinBalance] = useState(
    filters.minBalance !== null ? String(filters.minBalance) : '',
  );
  const [maxBalance, setMaxBalance] = useState(
    filters.maxBalance !== null ? String(filters.maxBalance) : '',
  );

  useEffect(() => {
    setMinBalance(filters.minBalance !== null ? String(filters.minBalance) : '');
    setMaxBalance(filters.maxBalance !== null ? String(filters.maxBalance) : '');
  }, [filters.minBalance, filters.maxBalance]);

  const toggleTier = (v: string) => {
    onChange({
      ...filters,
      tier: filters.tier.includes(v) ? filters.tier.filter((t) => t !== v) : [...filters.tier, v],
    });
  };

  const togglePayment = (v: string) => {
    onChange({
      ...filters,
      paymentStatus: filters.paymentStatus.includes(v)
        ? filters.paymentStatus.filter((t) => t !== v)
        : [...filters.paymentStatus, v],
    });
  };

  const commitBalances = () => {
    const min = minBalance === '' ? null : Number(minBalance);
    const max = maxBalance === '' ? null : Number(maxBalance);
    onChange({
      ...filters,
      minBalance: min !== null && Number.isFinite(min) ? min : null,
      maxBalance: max !== null && Number.isFinite(max) ? max : null,
    });
  };

  return (
    <div className="max-h-[70vh] overflow-y-auto">
      <div className="border-border flex items-center justify-between border-b px-4 py-3">
        <span className="text-sm font-medium">Filters</span>
        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onReset}>
          {'Reset all'}
        </Button>
      </div>

      <div className="border-border space-y-2 border-b px-4 py-3">
        <div className="text-muted-foreground text-xs font-medium">Subscription</div>
        <div className="flex items-center justify-between text-sm">
          <span>{'Has active subscription'}</span>
          <Select
            value={
              filters.hasSubscription === true
                ? 'yes'
                : filters.hasSubscription === false
                  ? 'no'
                  : 'any'
            }
            onValueChange={(v) =>
              onChange({
                ...filters,
                hasSubscription: v === 'yes' ? true : v === 'no' ? false : null,
              })
            }
          >
            <SelectTrigger className="h-7 w-[100px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="any">Any</SelectItem>
              <SelectItem value="yes">Yes</SelectItem>
              <SelectItem value="no">No</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="border-border space-y-2 border-b px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="text-muted-foreground text-xs font-medium">Tier</div>
          {filters.tier.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-xs"
              onClick={() => onChange({ ...filters, tier: [] })}
            >
              Clear
            </Button>
          )}
        </div>
        <div className="space-y-1">
          {TIER_OPTIONS.map((t, i) => (
            <div key={t.value}>
              {/* One heading, before the first grandfathered key — these are
                  still-honored plans no account can be moved onto today. */}
              {t.grandfathered && !TIER_OPTIONS[i - 1]?.grandfathered && (
                <div className="text-muted-foreground px-1.5 pt-2 pb-1 text-xs">Grandfathered</div>
              )}
              <label className="hover:bg-hover flex cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1 text-sm">
                <Checkbox
                  checked={filters.tier.includes(t.value)}
                  onCheckedChange={() => toggleTier(t.value)}
                />
                <span className="flex-1">{t.label}</span>
              </label>
            </div>
          ))}
        </div>
      </div>

      <div className="border-border space-y-2 border-b px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="text-muted-foreground text-xs font-medium">{'Payment status'}</div>
          {filters.paymentStatus.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-xs"
              onClick={() => onChange({ ...filters, paymentStatus: [] })}
            >
              Clear
            </Button>
          )}
        </div>
        <div className="space-y-1">
          {PAYMENT_STATUS_OPTIONS.map((p) => (
            <label
              key={p.value}
              className="hover:bg-hover flex cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1 text-sm"
            >
              <Checkbox
                checked={filters.paymentStatus.includes(p.value)}
                onCheckedChange={() => togglePayment(p.value)}
              />
              <span className="flex-1">{p.label}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="space-y-2 px-4 py-3">
        <div className="text-muted-foreground text-xs font-medium">Balance</div>
        <div className="flex items-center gap-2">
          <Input
            type="number"
            value={minBalance}
            onChange={(e) => setMinBalance(e.target.value)}
            onBlur={commitBalances}
            placeholder="Min"
            className="h-8 text-sm"
          />
          <span className="text-muted-foreground text-xs">to</span>
          <Input
            type="number"
            value={maxBalance}
            onChange={(e) => setMaxBalance(e.target.value)}
            onBlur={commitBalances}
            placeholder="Max"
            className="h-8 text-sm"
          />
        </div>
      </div>
    </div>
  );
}

function ActiveChips({
  filters,
  onChange,
  searchInput,
  onSearchChange,
}: {
  filters: AccountFilters;
  onChange: (f: AccountFilters) => void;
  searchInput: string;
  onSearchChange: (v: string) => void;
}) {
  const chips: Array<{ key: string; label: string; onRemove: () => void }> = [];

  if (searchInput) {
    chips.push({
      key: 'search',
      label: `Search: "${searchInput}"`,
      onRemove: () => onSearchChange(''),
    });
  }
  if (filters.paidOnly) {
    chips.push({
      key: 'paid',
      label: 'Paid only',
      onRemove: () => onChange({ ...filters, paidOnly: false }),
    });
  }
  for (const t of filters.tier) {
    chips.push({
      key: `tier:${t}`,
      label: `Tier: ${tierKeyLabel(t)}`,
      onRemove: () => onChange({ ...filters, tier: filters.tier.filter((x) => x !== t) }),
    });
  }
  for (const p of filters.paymentStatus) {
    chips.push({
      key: `payment:${p}`,
      label: `Status: ${p.replace(/_/g, ' ')}`,
      onRemove: () =>
        onChange({ ...filters, paymentStatus: filters.paymentStatus.filter((x) => x !== p) }),
    });
  }
  if (filters.hasSubscription === true) {
    chips.push({
      key: 'sub',
      label: 'Has subscription',
      onRemove: () => onChange({ ...filters, hasSubscription: null }),
    });
  } else if (filters.hasSubscription === false) {
    chips.push({
      key: 'sub',
      label: 'No subscription',
      onRemove: () => onChange({ ...filters, hasSubscription: null }),
    });
  }
  if (filters.minBalance !== null) {
    chips.push({
      key: 'min',
      label: `Balance ≥ ${filters.minBalance}`,
      onRemove: () => onChange({ ...filters, minBalance: null }),
    });
  }
  if (filters.maxBalance !== null) {
    chips.push({
      key: 'max',
      label: `Balance ≤ ${filters.maxBalance}`,
      onRemove: () => onChange({ ...filters, maxBalance: null }),
    });
  }

  if (chips.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {chips.map((chip) => (
        <Button
          key={chip.key}
          type="button"
          size="sm"
          variant="outline"
          onClick={chip.onRemove}
          className="rounded-full"
        >
          <span>{chip.label}</span>
          <X className="text-muted-foreground group-hover:text-foreground h-3 w-3" />
        </Button>
      ))}
      {chips.length > 1 && (
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground h-7 px-2 text-xs"
          onClick={() => {
            onSearchChange('');
            onChange({ ...EMPTY_FILTERS, sortBy: filters.sortBy, sortDir: filters.sortDir });
          }}
        >
          {'Clear all'}
        </Button>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sortable table header
// ─────────────────────────────────────────────────────────────────────────────

/** The accounts table's sortable header — the shared `AdminSortHeader`, bound
 *  to this page's column union. */
function SortHeader(props: {
  label: string;
  column: AdminAccountsSortBy;
  sortBy: AdminAccountsSortBy;
  sortDir: AdminAccountsSortDir;
  onSort: (col: AdminAccountsSortBy) => void;
  align?: 'left' | 'right';
}) {
  return <AdminSortHeader<AdminAccountsSortBy> {...props} />;
}

// ─────────────────────────────────────────────────────────────────────────────
// Detail sheet + tabs
// ─────────────────────────────────────────────────────────────────────────────

function AccountDetailSheet({
  account,
  onClose,
}: {
  account: AdminAccount | null;
  onClose: () => void;
}) {
  // 1120 on lg, not 960: the Ledger tab renders the same six-column credit
  // table the customer sees, which needs ~1040px before it starts hiding
  // "Credits after" behind a horizontal scrollbar nobody finds.
  return (
    <Sheet open={!!account} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        className="w-full bg-background overflow-y-auto p-0 sm:!max-w-[640px] md:!max-w-[820px] lg:!max-w-[1120px]"
      >
        {account && <AccountDetail account={account} />}
      </SheetContent>
    </Sheet>
  );
}

/**
 * "Open as account" — mint a one-hour act-as grant and walk into the product
 * as this customer.
 *
 * Behind a confirm, because it is the single most invasive thing this console
 * can do: from the click on, everything the operator sees and every write they
 * make lands on the customer's account, and the customer's own audit log
 * records it. The reason box is optional but asked for by default — it is what
 * makes the audit row answer "why" and not just "who".
 *
 * The navigation is a full page load, not a router push: the SDK's request
 * layer starts attaching the grant to every call, and a soft transition would
 * leave a React Query cache full of the OPERATOR's data behind a banner
 * naming the customer.
 */
function OpenAsAccountButton({ account }: { account: AdminAccount }) {
  const impersonate = useAdminImpersonate();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');

  const start = () => {
    impersonate.mutate(
      { accountId: account.accountId, reason: reason.trim() || undefined },
      {
        onSuccess: () => {
          setOpen(false);
          // Drop the "project you had open last" cookie first: it points at one
          // of the OPERATOR's own projects, and the landing door reads it. The
          // API now (correctly) refuses that project inside a session, because
          // impersonation confines the operator to one account.
          clearLastProjectId();
          // Land on the customer's ACCOUNT page, not the landing door. The
          // landing door is `/projects/start`, which AUTO-PROVISIONS a first
          // project for an account that has none — so simply opening a quiet
          // customer's account would silently create a project inside it. The
          // account page creates nothing and is where a support question about
          // billing, members or entitlements actually lives.
          //
          // A HARD load, deliberately — a router push would keep the React
          // Query cache this console filled with the operator's own data.
          // eslint-disable-next-line @next/next/no-location-assign-relative-destination
          window.location.assign(`/accounts/${account.accountId}`);
        },
        onError: (error) => errorToast(error.message || 'Could not open the account'),
      },
    );
  };

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} className="gap-1.5">
        <Eye className="h-3.5 w-3.5" />
        Open as account
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Act as ${accountLabelFor(account)}?`}
        description={
          <span className="space-y-3">
            <span className="block">
              For up to one hour, everything you do lands on this account. Every change you make is
              written to the customer's own audit log with your identity attached.
            </span>
            <Input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Reason (e.g. ticket #1234)"
              maxLength={500}
            />
          </span>
        }
        confirmLabel="Open as account"
        onConfirm={start}
        isPending={impersonate.isPending}
      />
    </>
  );
}

/**
 * A one-line identity value you copy by clicking it. The copy glyph fades in on
 * hover and swaps to a green check for ~1.5s after a copy. The whole row is the
 * hit target — Jay's note: "the email should be copyable, not a decorative
 * icon". Renders a plain muted line when there is no value.
 */
function CopyField({
  icon: Icon,
  value,
  placeholder,
  label,
  mono = false,
}: {
  icon: React.ComponentType<{ className?: string }>;
  value: string | null | undefined;
  placeholder: string;
  label: string;
  mono?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  if (!value) {
    return (
      <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
        <Icon className="size-3.5 shrink-0" />
        {placeholder}
      </span>
    );
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      errorToast('Could not copy to the clipboard');
    }
  };

  return (
    <Hint label={copied ? 'Copied' : `Copy ${label}`} side="bottom">
      <button
        type="button"
        onClick={copy}
        aria-label={`Copy ${label}`}
        className="group text-muted-foreground hover:text-foreground focus-visible:ring-ring -mx-1 flex max-w-full cursor-pointer items-center gap-1.5 rounded-md px-1 py-0.5 text-xs transition-colors outline-none focus-visible:ring-2 active:scale-[0.98]"
      >
        <Icon className="size-3.5 shrink-0" />
        <span className={cn('truncate', mono && 'font-mono')}>{value}</span>
        <span className="relative inline-flex size-3 shrink-0 items-center justify-center">
          {copied ? (
            <CheckIcon className="text-kortix-green size-3" />
          ) : (
            <CopyIcon className="size-3 opacity-0 transition-opacity group-hover:opacity-100" />
          )}
        </span>
      </button>
    </Hint>
  );
}

function AccountDetail({ account }: { account: AdminAccount }) {
  const usersQuery = useAdminAccountUsers(account.accountId);
  const projectsQuery = useAdminAccountProjects(account.accountId);
  const ledgerQuery = useAdminAccountLedger(account.accountId, 100);
  const actions = billingActionsFor(account);
  const balanceNegative = Number(account.balance ?? 0) < 0;
  const usersCount = usersQuery.data?.users?.length;
  const projectsCount = projectsQuery.data?.projects?.length;

  return (
    <div className="flex min-h-0 flex-col">
      <SheetHeader className="border-border gap-3 border-b px-6 py-5">
        {/* Title + who/what/where badges on the left; the one invasive action
            (Open as account) pinned top-right so it never hides under scroll. */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-2">
            <SheetTitle className="truncate text-lg font-semibold tracking-tight">
              {accountLabelFor(account)}
            </SheetTitle>
            <div className="flex flex-wrap items-center gap-1.5">
              <PlanBadge account={account} />
              {account.paymentStatus && account.paymentStatus !== 'active' && (
                <Badge
                  variant={paymentStatusBadge(account.paymentStatus)}
                  size="sm"
                  className="capitalize"
                >
                  {account.paymentStatus.replace(/_/g, ' ')}
                </Badge>
              )}
              {trialIsActive(account.trial) && (
                <Badge variant="success" size="sm">
                  Trial
                </Badge>
              )}
            </div>
          </div>
          <OpenAsAccountButton account={account} />
        </div>

        <SheetDescription className="sr-only">
          {`Account details for ${accountLabelFor(account)}`}
        </SheetDescription>

        {/* Identity: email and account id are both click-to-copy. */}
        <div className="flex flex-col items-start gap-1">
          <CopyField
            icon={Mail}
            value={account.ownerEmail}
            placeholder="No owner email"
            label="email"
          />
          <CopyField
            icon={IdentificationCardIcon}
            value={account.accountId}
            placeholder="No account ID"
            label="account ID"
            mono
          />
          <LiveSubscriptionLine accountId={account.accountId} />
        </div>

        {actions.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {actions.map((a) => (
              <a
                key={a.href}
                href={a.href}
                target="_blank"
                rel="noopener noreferrer"
                className="group border-border bg-popover text-foreground hover:bg-hover inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors active:scale-[0.98]"
              >
                <ServiceFavicon domain={a.domain} />
                {a.label}
                <ExternalLink className="text-muted-foreground group-hover:text-foreground size-3" />
              </a>
            ))}
          </div>
        )}
      </SheetHeader>

      <div className="space-y-6 px-6 py-6">
        <StatGrid className="grid-cols-2 lg:grid-cols-4">
          <StatTile
            label="Total balance"
            value={formatCredits(account.balance)}
            tone={balanceNegative ? 'danger' : 'default'}
          />
          <StatTile label="Expiring" value={formatCredits(account.expiringCredits)} />
          <StatTile label="Permanent" value={formatCredits(account.nonExpiringCredits)} />
          <StatTile label="Daily" value={formatCredits(account.dailyCreditsBalance)} />
        </StatGrid>

        <Tabs defaultValue="credits" className="w-full">
          {/* Underline section tabs — the brand's primary-tab style — replacing
              the wrapping pill pad. Scrolls horizontally on a narrow sheet
              rather than reflowing into a second row. */}
          <TabsList
            type="underline"
            className="w-full [scrollbar-width:none] justify-start gap-4 overflow-x-auto [&::-webkit-scrollbar]:hidden"
          >
            <TabsTrigger value="credits" className="w-fit flex-none gap-1.5">
              <CreditCard className="size-3.5 shrink-0" />
              Credits
            </TabsTrigger>
            <TabsTrigger value="entitlements" className="w-fit flex-none gap-1.5">
              <Key className="size-3.5 shrink-0" />
              Entitlements
            </TabsTrigger>
            <TabsTrigger value="users" className="w-fit flex-none gap-1.5">
              <Users className="size-3.5 shrink-0" />
              Users
              {usersCount != null && (
                <Badge variant="secondary" size="sm">
                  {usersCount}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="projects" className="w-fit flex-none gap-1.5">
              <FolderKanban className="size-3.5 shrink-0" />
              Projects
              {projectsCount != null && (
                <Badge variant="secondary" size="sm">
                  {projectsCount}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="ledger" className="w-fit flex-none gap-1.5">
              <History className="size-3.5 shrink-0" />
              Ledger
            </TabsTrigger>
            <TabsTrigger value="billing" className="w-fit flex-none gap-1.5">
              <Shield className="size-3.5 shrink-0" />
              Billing
            </TabsTrigger>
          </TabsList>

          <TabsContent value="credits" className="mt-5">
            <CreditsTab account={account} />
          </TabsContent>
          <TabsContent value="entitlements" className="mt-5">
            <EntitlementsTab account={account} />
          </TabsContent>
          <TabsContent value="users" className="mt-5">
            <UsersTab usersQuery={usersQuery} accountId={account.accountId} />
          </TabsContent>
          <TabsContent value="projects" className="mt-5">
            <ProjectsTab projectsQuery={projectsQuery} />
          </TabsContent>
          <TabsContent value="ledger" className="mt-5">
            <LedgerTab ledgerQuery={ledgerQuery} />
          </TabsContent>
          <TabsContent value="billing" className="mt-5">
            <BillingTab account={account} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

function CreditsTab({ account }: { account: AdminAccount }) {
  const grant = useAdminGrantCredits();
  const debit = useAdminDebitCredits();
  const setEnterpriseEntitled = useAdminSetEnterpriseEntitled();
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('Reimbursement');
  const [isExpiring, setIsExpiring] = useState(false);
  const [confirmDebit, setConfirmDebit] = useState(false);

  const parsed = Number(amount);
  const isValid = Number.isFinite(parsed) && parsed > 0;

  async function handleGrant() {
    if (!isValid) {
      errorToast('Enter a valid positive amount');
      return;
    }
    try {
      await grant.mutateAsync({
        accountId: account.accountId,
        amount: parsed,
        description: description.trim() || 'Admin credit adjustment',
        isExpiring,
      });
      successToast('Credits granted', {
        description: `${money(parsed)} added to ${accountLabelFor(account)}`,
      });
      setAmount('');
    } catch (error) {
      errorToast('Failed to grant credits', {
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  async function handleDebit() {
    if (!isValid) return;
    try {
      await debit.mutateAsync({
        accountId: account.accountId,
        amount: parsed,
        description: description.trim() || 'Admin debit',
      });
      successToast('Credits debited', {
        description: `${money(parsed)} removed from ${accountLabelFor(account)}`,
      });
      setAmount('');
    } catch (error) {
      errorToast('Failed to debit credits', {
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      setConfirmDebit(false);
    }
  }

  async function handleSetEnterprise(enabled: boolean) {
    try {
      await setEnterpriseEntitled.mutateAsync({ accountId: account.accountId, enabled });
      successToast(enabled ? 'Enterprise activated' : 'Enterprise entitlement revoked', {
        description: `${accountLabelFor(account)} ${enabled ? 'now has' : 'no longer has'} SSO, SCIM, RBAC and audit entitlements.`,
      });
    } catch (error) {
      errorToast('Failed to update Enterprise entitlement', {
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  const isEnterprise = account.enterpriseEntitled;

  return (
    <>
      {/* Plan / Enterprise activation. Enterprise is the `enterprise_entitled`
          FLAG, not a tier write: the flag survives Stripe subscription sync,
          while a `tier='enterprise'` write is reverted by the next
          customer.subscription.updated event (the bug this replaced). The
          plan shown is the RESOLVED one the API reports — an active trial and
          the per-seat self-heal overlay the stored tier, and the entitlement
          writes below act on the account, not on that plan. */}
      <div className="border-border bg-popover mb-4 space-y-3 rounded-md border p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-foreground text-sm font-medium">Plan</div>
            <div className="text-muted-foreground text-xs">
              Current: <span className="text-foreground font-medium">{planLabel(account)}</span>
              {account.plan?.sublabel ? ` · ${account.plan.sublabel}` : ''}
              {isEnterprise && ' · Enterprise entitlements active'}
            </div>
          </div>
          <PlanBadge account={account} size="default" />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => handleSetEnterprise(true)}
            disabled={setEnterpriseEntitled.isPending || isEnterprise}
            className="gap-1.5"
          >
            {setEnterpriseEntitled.isPending && <Loading className="h-3.5 w-3.5" />}
            {isEnterprise ? 'Enterprise active' : 'Activate Enterprise'}
          </Button>
          {isEnterprise && (
            <Button
              variant="outline"
              onClick={() => handleSetEnterprise(false)}
              disabled={setEnterpriseEntitled.isPending}
            >
              {'Revoke Enterprise entitlement'}
            </Button>
          )}
        </div>
        <p className="text-muted-foreground text-xs">
          {
            'Enterprise unlocks SAML SSO, SCIM directory sync, RBAC and audit access for this account. The billed plan and seat billing are unchanged.'
          }
        </p>
      </div>

      <div className="border-border bg-popover space-y-4 rounded-md border p-4">
        <div className="flex flex-wrap gap-1.5">
          {REIMBURSEMENT_PRESETS.map((n) => (
            <Button
              key={n}
              type="button"
              variant="outline"
              size="sm"
              className="h-7"
              onClick={() => setAmount(String(n))}
            >
              ${n}
            </Button>
          ))}
        </div>
        <div className="grid gap-2">
          <Input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder={'Amount (e.g. 25)'}
            step="0.01"
          />
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={'Reason / note'}
          />
          <label className="text-muted-foreground flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isExpiring}
              onChange={(e) => setIsExpiring(e.target.checked)}
              className="size-4"
            />
            {'Grant as expiring credits'}
          </label>
        </div>
        <div className="flex gap-2">
          <Button
            onClick={handleGrant}
            disabled={!isValid || grant.isPending || debit.isPending}
            className="flex-1 gap-1.5"
          >
            {grant.isPending ? (
              <Loading className="h-3.5 w-3.5" />
            ) : (
              <ArrowUpRight className="h-3.5 w-3.5" />
            )}
            {'Grant credits'}
          </Button>
          <Button
            variant="outline"
            onClick={() => setConfirmDebit(true)}
            disabled={!isValid || grant.isPending || debit.isPending}
            className="flex-1 gap-1.5"
          >
            <ArrowDownRight className="h-3.5 w-3.5" />
            Debit
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmDebit}
        onOpenChange={setConfirmDebit}
        title={'Debit credits?'}
        description={
          <div className="space-y-2 text-sm">
            <p>
              Deduct{' '}
              <span className="text-foreground font-mono">{isValid ? money(parsed) : '—'}</span>{' '}
              from <span className="font-medium">{accountLabelFor(account)}</span>.
            </p>
            <p className="text-muted-foreground text-xs">
              {
                'Will fail if the account has insufficient credits. Action is recorded in the ledger.'
              }
            </p>
          </div>
        }
        confirmLabel="Debit"
        onConfirm={handleDebit}
        isPending={debit.isPending}
      />
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Entitlements — trial + per-account overrides
// ─────────────────────────────────────────────────────────────────────────────

/** One labelled row inside an entitlement panel: text left, control right. */
function EntitlementRow({
  title,
  description,
  titleSuffix,
  children,
}: {
  title: string;
  description: string;
  /** Sits beside the title — an expiry chip, a status badge. */
  titleSuffix?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-foreground text-sm font-medium">{title}</span>
          {titleSuffix}
        </div>
        <p className="text-muted-foreground mt-0.5 max-w-prose text-xs">{description}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/**
 * The per-entitlement override rows. These apply AFTER the enterprise
 * expansion, which is what makes them useful: one capability can be switched
 * off for an account whose plan (or Enterprise flag) grants all of them.
 */
const OVERRIDE_ENTITLEMENT_ROWS: {
  key: BooleanOverrideKey;
  title: string;
  description: string;
}[] = [
  { key: 'sso', title: 'SSO', description: 'SAML / OIDC single sign-on for the account.' },
  { key: 'scim', title: 'SCIM', description: 'Directory-driven user provisioning.' },
  {
    key: 'rbac',
    title: 'Advanced RBAC',
    description: 'Custom roles and per-resource permissions.',
  },
  {
    key: 'auditAccess',
    title: 'Audit log access',
    description: "Read access to the account's own audit trail.",
  },
  {
    key: 'branding',
    title: 'Organization branding',
    description: 'Own logo, icon, favicon, and product name for every member.',
  },
  {
    key: 'managedModels',
    title: 'Managed models entitlement',
    description:
      'Applied after the switch above, so it can withdraw managed models from an otherwise entitled account.',
  },
];

const OVERRIDE_TRI_STATE_OPTIONS: { value: OverrideTriState; label: string }[] = [
  { value: 'inherit', label: 'Inherit' },
  { value: 'on', label: 'Force on' },
  { value: 'off', label: 'Force off' },
];

/** Short date for an expiry chip — the year matters, the minute does not. */
function formatDay(value: string): string {
  return new Date(value).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * An override with an `expires_at`. Shown even once it has lapsed: the row
 * projection does not apply expiry, so the operator sees what is stored and can
 * clear it.
 */
function OverrideExpiryChip({ expiresAt }: { expiresAt: string | null }) {
  if (!expiresAt) return null;
  const expired = isOverrideExpired(expiresAt);
  return (
    <Badge variant={expired ? 'muted' : 'warning'} size="xs">
      {expired ? `expired ${formatDay(expiresAt)}` : `expires ${formatDay(expiresAt)}`}
    </Badge>
  );
}

/**
 * Every override an account can carry, on one merge-patch save.
 *
 * The form holds a draft and sends only the rows that changed — see
 * `overrides-form.ts` for why an untouched row must never be re-sent. It has no
 * expiry field on purpose: an expiring grant comes from the trial primitive
 * above, and this card is where an operator inspects or clears one.
 */
function OverridesCard({ account }: { account: AdminAccount }) {
  const setOverrides = useAdminSetOverrides();
  const stored = account.entitlementOverrides ?? null;

  // Re-seed the draft whenever the account row changes underneath it (a save,
  // a trial grant, another operator). Comparing the serialized map is the
  // documented "adjust state during render" pattern — no effect, no flash of
  // stale controls.
  const storedKey = JSON.stringify(stored ?? {});
  const [syncedKey, setSyncedKey] = useState(storedKey);
  const [draft, setDraft] = useState<OverridesDraft>(() => draftFromOverrides(stored));
  if (storedKey !== syncedKey) {
    setSyncedKey(storedKey);
    setDraft(draftFromOverrides(stored));
  }

  const result = overridesPatch(draft, stored);
  const patch = result.ok ? result.patch : {};
  const nothingToSave = result.ok && isEmptyPatch(patch);
  const dirty = !result.ok || !nothingToSave;

  function setRow<K extends keyof OverridesDraft>(key: K, value: OverridesDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  async function handleSave() {
    if (!result.ok || isEmptyPatch(result.patch)) return;
    try {
      await setOverrides.mutateAsync({ accountId: account.accountId, patch: result.patch });
      successToast('Overrides saved', { description: describeOverridePatch(result.patch) });
    } catch (error) {
      errorToast('Failed to save overrides', {
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  const effectiveMultiplier = account.computeRateMultiplier;

  return (
    <div className="border-border bg-popover space-y-4 rounded-md border p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-foreground text-sm font-medium">Overrides</div>
          <p className="text-muted-foreground mt-0.5 max-w-prose text-xs">
            Per-account values that beat the plan. Blank or Inherit means the plan decides. Saving a
            row writes it permanently — a grant that should end belongs in a trial.
          </p>
        </div>
        {dirty && (
          <Badge variant="kortix" size="sm">
            unsaved
          </Badge>
        )}
      </div>

      <div className="border-border divide-border divide-y rounded-md border">
        {OVERRIDE_ENTITLEMENT_ROWS.map(({ key, title, description }) => (
          <div key={key} className="px-4 py-3">
            <EntitlementRow
              title={title}
              description={description}
              titleSuffix={<OverrideExpiryChip expiresAt={overrideExpiresAt(stored, key)} />}
            >
              <Select
                value={draft[key]}
                onValueChange={(value) => setRow(key, value as OverrideTriState)}
                disabled={setOverrides.isPending}
              >
                <SelectTrigger className="h-8 w-[140px]" aria-label={`${title} override`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {OVERRIDE_TRI_STATE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </EntitlementRow>
          </div>
        ))}

        <div className="px-4 py-3">
          <EntitlementRow
            title="Max concurrent sessions"
            description="Session cap for the whole account. Blank inherits the plan cap."
            titleSuffix={
              <OverrideExpiryChip expiresAt={overrideExpiresAt(stored, 'maxConcurrentSessions')} />
            }
          >
            <Input
              type="number"
              min={1}
              max={MAX_CONCURRENT_SESSIONS_OVERRIDE}
              step={1}
              inputMode="numeric"
              placeholder="Plan cap"
              className="h-8 w-[140px] tabular-nums"
              aria-label="Max concurrent sessions override"
              value={draft.maxConcurrentSessions}
              disabled={setOverrides.isPending}
              onChange={(e) => setRow('maxConcurrentSessions', e.target.value)}
            />
          </EntitlementRow>
        </div>

        <div className="px-4 py-3">
          <EntitlementRow
            title="Compute rate multiplier"
            description="0.5 = half-price compute, 0 = free, blank = plan default."
            titleSuffix={
              <OverrideExpiryChip expiresAt={overrideExpiresAt(stored, 'computeRateMultiplier')} />
            }
          >
            <Input
              type="number"
              min={0}
              max={MAX_COMPUTE_RATE_MULTIPLIER}
              step={0.05}
              inputMode="decimal"
              placeholder="1"
              className="h-8 w-[140px] tabular-nums"
              aria-label="Compute rate multiplier override"
              value={draft.computeRateMultiplier}
              disabled={setOverrides.isPending}
              onChange={(e) => setRow('computeRateMultiplier', e.target.value)}
            />
          </EntitlementRow>
          {effectiveMultiplier !== undefined && (
            <p className="text-muted-foreground mt-2 text-xs">
              Sandbox compute currently bills at{' '}
              <span className="text-foreground tabular-nums">{effectiveMultiplier}×</span> list
              price.
            </p>
          )}
        </div>
      </div>

      {!result.ok && <p className="text-kortix-red text-xs">{result.error}</p>}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          onClick={handleSave}
          disabled={!dirty || !result.ok || setOverrides.isPending}
          className="gap-1.5"
        >
          {setOverrides.isPending && <Loading className="h-3.5 w-3.5" />}
          Save overrides
        </Button>
        {dirty && (
          <Button
            variant="outline"
            onClick={() => setDraft(draftFromOverrides(stored))}
            disabled={setOverrides.isPending}
          >
            Reset
          </Button>
        )}
      </div>
    </div>
  );
}

function EntitlementsTab({ account }: { account: AdminAccount }) {
  const grantTrial = useAdminGrantTrial();
  const revokeTrial = useAdminRevokeTrial();
  const setManagedModels = useAdminSetManagedModels();
  const setEnterpriseDemo = useAdminSetEnterpriseDemo();
  const setEnterpriseEntitled = useAdminSetEnterpriseEntitled();

  const trial = account.trial;
  const isActive = trialIsActive(trial);

  const [tierKey, setTierKey] = useState('team');
  const [seats, setSeats] = useState('5');
  const [durationDays, setDurationDays] = useState('30');
  const [creditGrant, setCreditGrant] = useState('25');
  const [note, setNote] = useState('');
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  const parsedSeats = Number(seats);
  const parsedDuration = Number(durationDays);
  const parsedCredit = Number(creditGrant);
  const seatsValid =
    Number.isInteger(parsedSeats) && parsedSeats >= 1 && parsedSeats <= MAX_TRIAL_SEATS;
  const durationValid =
    Number.isInteger(parsedDuration) &&
    parsedDuration >= 1 &&
    parsedDuration <= MAX_TRIAL_DURATION_DAYS;
  const creditValid =
    creditGrant.trim() === '' ||
    (Number.isFinite(parsedCredit) && parsedCredit >= 0 && parsedCredit <= MAX_TRIAL_CREDIT_GRANT);
  const formValid = seatsValid && durationValid && creditValid;

  const accountLabel = accountLabelFor(account);

  async function handleGrantTrial() {
    if (!formValid) return;
    try {
      await grantTrial.mutateAsync({
        accountId: account.accountId,
        tierKey,
        seats: parsedSeats,
        durationDays: parsedDuration,
        creditGrant: creditGrant.trim() === '' ? undefined : parsedCredit,
        note: note.trim() === '' ? undefined : note.trim(),
      });
      successToast(isActive ? 'Trial replaced' : 'Trial granted', {
        description: `${accountLabel} behaves as ${tierKeyLabel(tierKey)} for ${parsedDuration} days.`,
      });
      setNote('');
    } catch (error) {
      errorToast('Failed to grant trial', {
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  async function handleRevokeTrial() {
    try {
      await revokeTrial.mutateAsync({ accountId: account.accountId });
      successToast('Trial revoked', { description: `${accountLabel} is back on its billed tier.` });
    } catch (error) {
      errorToast('Failed to revoke trial', {
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      setConfirmRevoke(false);
    }
  }

  async function handleManagedModels(override: boolean | null) {
    try {
      await setManagedModels.mutateAsync({ accountId: account.accountId, override });
      successToast('Managed models updated', {
        description:
          override === null
            ? 'The effective tier decides again.'
            : override
              ? 'Managed models forced on.'
              : 'Restricted to BYOK keys.',
      });
    } catch (error) {
      errorToast('Failed to set managed models', {
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  async function handleEnterpriseDemo(enabled: boolean) {
    try {
      await setEnterpriseDemo.mutateAsync({ accountId: account.accountId, enabled });
      successToast(enabled ? 'Enterprise demo enabled' : 'Enterprise demo disabled');
    } catch (error) {
      errorToast('Failed to set enterprise demo', {
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  async function handleEnterpriseEntitled(enabled: boolean) {
    try {
      await setEnterpriseEntitled.mutateAsync({ accountId: account.accountId, enabled });
      successToast(
        enabled ? 'Enterprise contract entitlements on' : 'Enterprise contract entitlements off',
      );
    } catch (error) {
      errorToast('Failed to set enterprise entitlements', {
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  const managedModelsChoices: { value: boolean | null; label: string }[] = [
    { value: null, label: 'Default (tier)' },
    { value: true, label: 'Force on' },
    { value: false, label: 'BYOK only' },
  ];

  return (
    <div className="space-y-4">
      {/* Trial — an admin-issued overlay: the account BEHAVES as the trial tier
          until it ends, without touching credit_accounts.tier (Stripe owns
          that). Re-granting overwrites the window: extend = re-grant. */}
      <div className="border-border bg-popover space-y-4 rounded-md border p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-foreground text-sm font-medium">Trial</div>
            <p className="text-muted-foreground mt-0.5 text-xs">
              Emulates a paid tier for a fixed window. Billed tier stays{' '}
              <span className="text-foreground">{tierKeyLabel(account.tier)}</span>.
            </p>
          </div>
          <Badge variant={trialBadgeVariant(trial?.status ?? null)} size="sm">
            {trial?.status ?? 'none'}
          </Badge>
        </div>

        {trial && trial.status !== 'none' ? (
          <div className="border-border divide-border grid grid-cols-1 divide-y rounded-md border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
            <div className="px-3 py-2.5">
              <div className="text-muted-foreground text-xs">Tier</div>
              <div className="mt-0.5 text-sm font-medium">
                {trial.tier ? tierKeyLabel(trial.tier) : '—'}
                {trial.seats != null && (
                  <span className="text-muted-foreground font-normal">
                    {' '}
                    · {trial.seats} seat{trial.seats === 1 ? '' : 's'}
                  </span>
                )}
              </div>
            </div>
            {/* A revoked or converted trial keeps its original window for audit,
                and that window can still be in the future — so the countdown is
                only meaningful while the trial is active. */}
            <div className="px-3 py-2.5">
              <div className="text-muted-foreground text-xs">
                {isActive ? 'Ends' : 'Window ended'}
              </div>
              <div className="mt-0.5 text-sm font-medium">
                {isActive ? formatCountdown(trial.endsAt) : formatDateTime(trial.endsAt)}
              </div>
              {isActive && (
                <div className="text-muted-foreground text-xs">{formatDateTime(trial.endsAt)}</div>
              )}
            </div>
            <div className="px-3 py-2.5">
              <div className="text-muted-foreground text-xs">Started</div>
              <div className="mt-0.5 text-sm font-medium">{formatRelative(trial.startedAt)}</div>
              <div className="text-muted-foreground text-xs">{formatDateTime(trial.startedAt)}</div>
            </div>
          </div>
        ) : (
          <p className="text-muted-foreground text-xs">No trial has ever been issued.</p>
        )}

        {trial?.note && (
          <p className="text-muted-foreground border-border border-l-2 pl-3 text-xs">
            {trial.note}
          </p>
        )}

        {/* Grant / replace form */}
        <div className="border-border space-y-3 border-t pt-4">
          <div className="text-foreground text-sm font-medium">
            {isActive ? 'Replace trial' : 'Grant trial'}
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            <div className="space-y-1">
              <label className="text-muted-foreground text-xs">Tier</label>
              <Select value={tierKey} onValueChange={setTierKey}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TRIAL_TIER_OPTIONS.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      <span>{t.label}</span>
                      <span className="text-muted-foreground ml-1.5 text-xs">{t.hint}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-muted-foreground text-xs">
                Model access is the Managed models switch below, not the tier.
              </p>
            </div>
            <div className="space-y-1">
              <label className="text-muted-foreground text-xs">Seats</label>
              <Input
                type="number"
                min={1}
                max={MAX_TRIAL_SEATS}
                step={1}
                value={seats}
                onChange={(e) => setSeats(e.target.value)}
                aria-invalid={!seatsValid}
              />
            </div>
            <div className="space-y-1">
              <label className="text-muted-foreground text-xs">Credit grant ($)</label>
              <Input
                type="number"
                min={0}
                max={MAX_TRIAL_CREDIT_GRANT}
                step="0.01"
                value={creditGrant}
                onChange={(e) => setCreditGrant(e.target.value)}
                aria-invalid={!creditValid}
              />
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-muted-foreground text-xs">Duration</label>
            <div className="flex flex-wrap items-center gap-1.5">
              {TRIAL_DURATION_PRESETS.map((d) => (
                <Button
                  key={d}
                  type="button"
                  size="sm"
                  variant={durationDays === String(d) ? 'default' : 'outline'}
                  className="h-7"
                  onClick={() => setDurationDays(String(d))}
                >
                  {d}d
                </Button>
              ))}
              <Input
                type="number"
                min={1}
                max={MAX_TRIAL_DURATION_DAYS}
                step={1}
                value={durationDays}
                onChange={(e) => setDurationDays(e.target.value)}
                aria-label="Custom trial duration in days"
                aria-invalid={!durationValid}
                className="h-7 w-24"
              />
            </div>
          </div>

          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note (why, who asked, deal context)"
            maxLength={2000}
          />

          <div className="flex flex-wrap gap-2">
            <Button
              onClick={handleGrantTrial}
              disabled={!formValid || grantTrial.isPending || revokeTrial.isPending}
              className="gap-1.5"
            >
              {grantTrial.isPending && <Loading className="h-3.5 w-3.5" />}
              {isActive ? 'Replace trial' : 'Grant trial'}
            </Button>
            {isActive && (
              <Button
                variant="outline"
                onClick={() => setConfirmRevoke(true)}
                disabled={grantTrial.isPending || revokeTrial.isPending}
              >
                Revoke trial
              </Button>
            )}
          </div>
          <p className="text-muted-foreground text-xs">
            Credits fund sandbox compute — even a BYOK trial needs wallet balance to run sessions.
            The free welcome grant is $2; one per-seat month is $25.
          </p>
        </div>
      </div>

      {/* Managed models override — tri-state, null restores tier control. */}
      <div className="border-border bg-popover space-y-3 rounded-md border p-4">
        <EntitlementRow
          title="Managed models"
          description="Force Kortix-credential models on, restrict the account to its own BYOK keys, or leave the decision to the effective tier."
        >
          <div className="flex flex-wrap gap-1.5">
            {managedModelsChoices.map((choice) => (
              <Button
                key={String(choice.value)}
                type="button"
                size="sm"
                variant={account.managedModelsOverride === choice.value ? 'default' : 'outline'}
                className="h-7"
                disabled={setManagedModels.isPending}
                onClick={() => handleManagedModels(choice.value)}
              >
                {choice.label}
              </Button>
            ))}
          </div>
        </EntitlementRow>
      </div>

      {/* Enterprise flags. Demo = evaluation preview; entitled = signed contract. */}
      <div className="border-border bg-popover space-y-4 rounded-md border p-4">
        <EntitlementRow
          title="Enterprise demo"
          description="Interactive preview of SSO, SCIM, advanced RBAC, and audit logs. Evaluation only — no billing change."
        >
          <Switch
            checked={account.demoEnterprise}
            disabled={setEnterpriseDemo.isPending}
            onCheckedChange={handleEnterpriseDemo}
            aria-label="Toggle enterprise demo"
          />
        </EntitlementRow>

        <div className="border-border border-t pt-4">
          <EntitlementRow
            title="Enterprise contract entitlements"
            description="Keeps SSO, SCIM, RBAC, and audit entitled for a signed Enterprise account that is also per-seat billed, so the Stripe reconciliation cannot strip them."
          >
            <Switch
              checked={account.enterpriseEntitled}
              disabled={setEnterpriseEntitled.isPending}
              onCheckedChange={handleEnterpriseEntitled}
              aria-label="Toggle enterprise contract entitlements"
            />
          </EntitlementRow>
        </div>
      </div>

      {/* Every remaining override, on one merge-patch save. Sits last because
          the resolver applies these last: plan → enterprise expansion →
          managed-models switch → these. */}
      <OverridesCard account={account} />

      {/* Read-only context the operator needs before issuing a trial. */}
      <div className="border-border bg-popover divide-border grid grid-cols-2 divide-x rounded-md border text-sm">
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <span className="text-muted-foreground text-xs">Billing model</span>
          <span className="text-right font-medium">{account.billingModel || '—'}</span>
        </div>
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <span className="text-muted-foreground text-xs">Seats</span>
          <span className="text-right font-medium">{account.seatCount ?? '—'}</span>
        </div>
      </div>

      <ConfirmDialog
        open={confirmRevoke}
        onOpenChange={setConfirmRevoke}
        title="Revoke trial"
        description={
          <div className="space-y-2 text-sm">
            <p>
              <span className="font-medium">{accountLabel}</span> drops back to{' '}
              <span className="text-foreground font-medium">{tierKeyLabel(account.tier)}</span>{' '}
              immediately.
            </p>
            <p className="text-muted-foreground text-xs">
              Entitlements, project and session limits, and the managed-models gate all revert on
              the next request. Credits already granted are not clawed back.
            </p>
          </div>
        }
        confirmLabel="Revoke trial"
        onConfirm={handleRevokeTrial}
        isPending={revokeTrial.isPending}
      />
    </div>
  );
}

const MEMBER_ROLES: AdminAccountMemberRole[] = ['owner', 'admin', 'member'];

function UsersTab({
  usersQuery,
  accountId,
}: {
  usersQuery: ReturnType<typeof useAdminAccountUsers>;
  accountId: string;
}) {
  const setMemberRole = useAdminSetMemberRole();

  async function handleRoleChange(userId: string, email: string, role: AdminAccountMemberRole) {
    try {
      await setMemberRole.mutateAsync({ accountId, userId, role });
      successToast('Role updated', { description: `${email} is now ${role}.` });
    } catch (error) {
      errorToast('Failed to update role', {
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  if (usersQuery.isLoading) {
    return (
      <div className="border-border bg-popover text-muted-foreground flex items-center gap-2 rounded-md border px-4 py-6 text-sm">
        <Loading className="size-4 shrink-0" />
        {'Loading users…'}
      </div>
    );
  }

  const users = usersQuery.data?.users ?? [];
  if (users.length === 0) {
    return (
      <div className="border-border bg-popover rounded-md border">
        <EmptyState
          icon={IconInbox}
          title={'No users on this account'}
          description={'Members will appear here once users are added.'}
          size="sm"
        />
      </div>
    );
  }

  return (
    <div className="border-border bg-popover divide-border divide-y rounded-md border">
      {users.map((user) => {
        const banned = user.banned_until && new Date(user.banned_until) > new Date();
        const confirmed = !!user.email_confirmed_at;
        return (
          <div key={user.user_id} className="flex flex-col gap-2 px-4 py-3 text-sm">
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate font-medium">{user.email}</span>
                {confirmed ? (
                  <CheckCircle2 weight="fill" className="text-kortix-green size-3.5 shrink-0" />
                ) : (
                  <Badge variant="warning" size="sm">
                    unverified
                  </Badge>
                )}
                {banned && (
                  <Badge variant="destructive" size="sm" className="gap-1">
                    <Ban className="size-3 shrink-0" />
                    banned
                  </Badge>
                )}
              </div>
              <Select
                value={user.account_role}
                disabled={setMemberRole.isPending}
                onValueChange={(role) =>
                  handleRoleChange(user.user_id, user.email, role as AdminAccountMemberRole)
                }
              >
                <SelectTrigger size="sm" className="h-7 w-[7.5rem] shrink-0 text-xs capitalize">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end">
                  {MEMBER_ROLES.map((role) => (
                    <SelectItem key={role} value={role} className="capitalize">
                      {role}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="text-muted-foreground grid grid-cols-2 gap-2 text-xs">
              <div className="truncate">
                <span className="text-muted-foreground">{'Last sign-in:'}</span>
                <span className="text-foreground">
                  {user.last_sign_in_at ? formatRelative(user.last_sign_in_at) : 'Never'}
                </span>
              </div>
              <div className="truncate">
                <span className="text-muted-foreground">{'Signed up:'}</span>
                <span className="text-foreground">
                  {user.signed_up_at ? formatRelative(user.signed_up_at) : '—'}
                </span>
              </div>
              <div className="truncate">
                <span className="text-muted-foreground">Provider: </span>
                <span className="text-foreground capitalize">{user.provider || '—'}</span>
              </div>
              <div className="truncate font-mono text-xs">{user.user_id.slice(0, 8)}…</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ProjectsTab({
  projectsQuery,
}: {
  projectsQuery: ReturnType<typeof useAdminAccountProjects>;
}) {
  if (projectsQuery.isLoading) {
    return (
      <div className="border-border bg-popover text-muted-foreground flex items-center gap-2 rounded-md border px-4 py-6 text-sm">
        <Loading className="size-4 shrink-0" />
        Loading projects…
      </div>
    );
  }

  const projects = projectsQuery.data?.projects ?? [];
  if (projects.length === 0) {
    return (
      <div className="border-border bg-popover rounded-md border">
        <EmptyState
          icon={FolderKanban}
          title="No projects on this account"
          description="Projects will appear here once the user creates one."
          size="sm"
        />
      </div>
    );
  }

  return (
    <div className="border-border bg-popover divide-border divide-y rounded-md border">
      {projects.map((project) => (
        <a
          key={project.projectId}
          href={`/projects/${project.projectId}`}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:bg-hover flex flex-col gap-2 px-4 py-3 text-sm transition-colors"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate font-medium">{project.name}</span>
              {project.activeSessionCount > 0 && (
                <Badge variant="success" size="sm">
                  {project.activeSessionCount} active
                </Badge>
              )}
              {project.status && project.status !== 'active' && (
                <Badge variant="muted" size="sm" className="capitalize">
                  {project.status}
                </Badge>
              )}
            </div>
            <ExternalLink className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
          </div>
          <div className="text-muted-foreground grid grid-cols-2 gap-2 text-xs">
            <div className="truncate">
              <span className="text-muted-foreground">Sessions: </span>
              <span className="text-foreground">{project.sessionCount}</span>
            </div>
            <div className="truncate">
              <span className="text-muted-foreground">Last activity: </span>
              <span className="text-foreground">
                {project.lastSessionAt ? formatRelative(project.lastSessionAt) : '—'}
              </span>
            </div>
            <div className="truncate">
              <span className="text-muted-foreground">Updated: </span>
              <span className="text-foreground">{formatRelative(project.updatedAt)}</span>
            </div>
            <div className="truncate font-mono text-xs">{project.projectId.slice(0, 8)}…</div>
          </div>
        </a>
      ))}
    </div>
  );
}

function formatRelative(value: string | null) {
  if (!value) return '—';
  const diff = Date.now() - new Date(value).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  const days = Math.floor(diff / 86_400_000);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function LedgerTab({ ledgerQuery }: { ledgerQuery: ReturnType<typeof useAdminAccountLedger> }) {
  if (ledgerQuery.isLoading) {
    return (
      <div className="border-border bg-popover text-muted-foreground flex items-center gap-2 rounded-md border px-4 py-6 text-sm">
        <Loading className="size-4 shrink-0" />
        {'Loading ledger…'}
      </div>
    );
  }

  const entries = ledgerQuery.data?.entries ?? [];
  if (entries.length === 0) {
    return (
      <div className="border-border bg-popover rounded-md border">
        <EmptyState
          icon={IconInbox}
          title={'No ledger entries'}
          description={'Credit activity will show up here.'}
          size="sm"
        />
      </div>
    );
  }

  // The same table the customer sees under Billing → Credit ledger, fed from
  // the admin endpoint. One implementation, so an operator reading a support
  // ticket and the customer reading their own history see identical rows.
  return (
    <div className="max-h-[50vh] overflow-y-auto">
      <CreditTransactionsTable rows={adminLedgerRows(entries)} />
    </div>
  );
}

function BillingTab({ account }: { account: AdminAccount }) {
  const actions = billingActionsFor(account);

  const summary: Array<[string, React.ReactNode]> = [
    ['Plan', <PlanBadge key="tier" account={account} />],
    [
      'Payment status',
      account.paymentStatus ? (
        <Badge
          key="ps"
          variant={paymentStatusBadge(account.paymentStatus)}
          size="sm"
          className="capitalize"
        >
          {account.paymentStatus.replace(/_/g, ' ')}
        </Badge>
      ) : (
        '—'
      ),
    ],
    ['Plan type', account.planType || '—'],
    ['Provider', account.provider || '—'],
    ['Billing email', account.billingCustomerEmail || '—'],
    ['Created', account.createdAt ? formatDateTime(account.createdAt) : '—'],
  ];

  const idRows: Array<{ label: string; value: string | null; href: string | null }> = [
    { label: 'Account ID', value: account.accountId, href: null },
    {
      label: 'Stripe subscription',
      value: account.stripeSubscriptionId,
      href: account.stripeSubscriptionId?.startsWith('sub_')
        ? stripeUrl('subscription', account.stripeSubscriptionId)
        : null,
    },
    {
      label: 'Stripe customer',
      value: account.billingCustomerId,
      href: account.billingCustomerId?.startsWith('cus_')
        ? stripeUrl('customer', account.billingCustomerId)
        : null,
    },
  ];

  return (
    <div className="space-y-4">
      {actions.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {actions.map((a) => (
            <a
              key={a.href}
              href={a.href}
              target="_blank"
              rel="noopener noreferrer"
              className="group border-border bg-popover hover:bg-hover inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors"
            >
              <ServiceFavicon domain={a.domain} />
              {a.label}
              <ExternalLink className="text-muted-foreground group-hover:text-foreground h-3 w-3" />
            </a>
          ))}
        </div>
      )}

      <div className="border-border bg-popover rounded-md border text-sm">
        <div className="divide-border grid grid-cols-1 divide-y sm:grid-cols-2 sm:divide-x sm:divide-y-0">
          {summary.map(([label, value]) => (
            <div key={label} className="flex items-center justify-between gap-3 px-4 py-3">
              <span className="text-muted-foreground text-xs">{label}</span>
              <span className="text-right font-medium">{value}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="border-border bg-popover divide-border divide-y rounded-md border text-sm">
        {idRows.map(({ label, value, href }) => (
          <div
            key={label}
            className="flex flex-col gap-1 px-4 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-6"
          >
            <span className="text-muted-foreground shrink-0 text-xs sm:w-40">{label}</span>
            {value ? (
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <code className="text-foreground bg-muted/30 min-w-0 flex-1 rounded px-2 py-1 font-mono text-xs break-all">
                  {value}
                </code>
                {href && (
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="border-border bg-popover text-muted-foreground hover:bg-hover hover:text-foreground inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-1 text-xs font-medium transition-colors"
                    title={'Open in Stripe'}
                  >
                    <ServiceFavicon domain="stripe.com" className="h-3 w-3" />
                    Open
                  </a>
                )}
              </div>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

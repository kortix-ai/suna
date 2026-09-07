'use client';

import type { UiTranslator } from '@/i18n/translator';
import { useLocalizedUiCatalog } from '@/i18n/use-localized-ui-catalog';
import { useTranslations as useI18nTranslations } from '@/i18n/use-translations';
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

function billingActionsFor(account: AdminAccount, tI18nComplete: UiTranslator): BillingAction[] {
  const actions: BillingAction[] = [];
  if (account.stripeSubscriptionId?.startsWith('sub_')) {
    actions.push({
      label: tI18nComplete.raw('textf4034f3d4b32'),
      href: stripeUrl('subscription', account.stripeSubscriptionId),
      domain: 'stripe.com',
    });
  }
  if (account.billingCustomerId?.startsWith('cus_')) {
    actions.push({
      label: tI18nComplete.raw('text0def42d1eccc'),
      href: stripeUrl('customer', account.billingCustomerId),
      domain: 'stripe.com',
    });
  }
  if (account.provider?.toLowerCase() === 'revenuecat') {
    actions.push({
      label: tI18nComplete.raw('text834daa2914fb'),
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
function tierKeyLabel(
  tier: string | null | undefined,
  options: readonly TierFilterOption[] = TIER_OPTIONS,
): string {
  if (!tier) return 'No plan';
  return options.find((option) => option.value === tier)?.label ?? TIER_LABELS[tier] ?? tier;
}

/**
 * The plan the account BEHAVES as, straight off the API's resolved `plan`
 * block: an active admin trial and the per-seat self-heal overlay the stored
 * `tier` column, and the resolver applies the same precedence every gate does.
 * The stored key stays available as `account.tier` for the filter.
 *
 * The fallback covers a console pointed at an API older than the resolver.
 */
function planLabel(account: AdminAccount, options?: readonly TierFilterOption[]): string {
  return account.plan?.label ?? tierKeyLabel(account.tier, options);
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
  const tierOptions = useLocalizedUiCatalog(TIER_OPTIONS);
  const sublabel = account.plan?.sublabel;
  return (
    <Badge variant={planBadgeVariant(account)} size={size} className={className}>
      {planLabel(account, tierOptions)}
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
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const { data, error } = useAdminAccountSubscription(accountId);
  const sub = data?.subscription;
  // A lookup that FAILS is itself the finding: the account row carries a
  // subscription id Stripe does not know (stale/rotated/wrong Stripe account).
  // Swallowing it would render the same blank line as "no subscription".
  if (error) {
    return (
      <span className="text-destructive flex items-center gap-1.5 text-xs">
        <CreditCard className="h-3 w-3 shrink-0" />
        <span className="truncate">
          {tI18nComplete.raw('text3573c6a20ab0')}
          {error.message}
        </span>
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
        {tI18nComplete.raw('text3f197cd0d612')}
        {amount ?? tI18nComplete.raw('text4e445fd409fb')}
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
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
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
      title={tI18nComplete.raw('text8a7c8b67fe8b')}
      description={tI18nComplete.raw('text9f5eff06b203')}
      action={<AdminRefreshButton busy={isFetching} onRefresh={() => void refetch()} />}
    >
      <StatGrid>
        <StatTile
          label={tI18nComplete.raw('text9dea85290e57')}
          value={total.toLocaleString()}
          hint={
            filtersCount > 0
              ? tI18nComplete.raw('text904eb9015563')
              : tI18nComplete.raw('textf4f6813aa30f')
          }
        />
        <StatTile
          label={tI18nComplete.raw('textfb81b961af45')}
          value={(summary?.paidCount ?? 0).toLocaleString()}
          tone="success"
          hint={tI18nComplete.raw('text38ba7f9cc345')}
        />
        <StatTile
          label={tI18nComplete.raw('text98d2f310af85')}
          value={formatCredits(summary?.totalCredits ?? 0)}
          hint={tI18nComplete.raw('text5bd8a81336da')}
        />
        <StatTile
          label={tI18nComplete.raw('text629c555fb7f8')}
          value={summary?.pastDueCount ?? 0}
          tone={(summary?.pastDueCount ?? 0) > 0 ? 'warning' : 'default'}
          hint={
            (summary?.pastDueCount ?? 0) > 0
              ? tI18nComplete.raw('text07297fa94a99')
              : tI18nComplete.raw('text96ed94a7e3ac')
          }
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
              search || filtersCount > 0
                ? tI18nComplete.raw('text56f26c55e418')
                : tI18nComplete.raw('text84a7e27178d9')
            }
            description={
              search || filtersCount > 0 ? tI18nComplete.raw('text0713dbee5126') : undefined
            }
            action={
              search || filtersCount > 0 ? (
                <Button variant="outline" size="sm" onClick={resetFilters}>
                  {tI18nComplete.raw('text7179ea0035fc')}
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
                  label={tI18nComplete.raw('text7e1b0d5641f2')}
                  column="name"
                  sortBy={filters.sortBy}
                  sortDir={filters.sortDir}
                  onSort={setSort}
                />
                <TableHead>{tI18nComplete.raw('textfa8ed0bdabdd')}</TableHead>
                <SortHeader
                  label={tI18nComplete.raw('textd05e07b7c14e')}
                  column="balance"
                  sortBy={filters.sortBy}
                  sortDir={filters.sortDir}
                  onSort={setSort}
                  align="right"
                />
                <SortHeader
                  label={tI18nComplete.raw('text1044a4c056d0')}
                  column="members"
                  sortBy={filters.sortBy}
                  sortDir={filters.sortDir}
                  onSort={setSort}
                  align="right"
                />
                <TableHead>{tI18nComplete.raw('text920e413c7d41')}</TableHead>
                <SortHeader
                  label={tI18nComplete.raw('textd70b9e24bca2')}
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
                        {account.ownerEmail || tI18nComplete.raw('textaca82dbb8ef0')}
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
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <AdminSearch
          value={searchInput}
          onChange={onSearchChange}
          placeholder={tI18nComplete.raw('text9640e38947da')}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="border-input bg-popover flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm">
          <Switch
            checked={filters.paidOnly}
            onCheckedChange={(v) => onFiltersChange({ ...filters, paidOnly: v })}
            aria-label={tI18nComplete.raw('text7dcfbf6997e9')}
          />
          <span className="text-sm">{tI18nComplete.raw('text4eaea5edcdef')}</span>
        </label>

        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm">
              <Filter className="h-3.5 w-3.5" />
              {tI18nComplete.raw('text546ebb8eb993')}
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
            <SelectValue placeholder={tI18nComplete.raw('textbec69036aa27')} />
          </SelectTrigger>
          <SelectContent align="end">
            <SelectItem value="created:desc">{tI18nComplete.raw('textffb6f5764bdd')}</SelectItem>
            <SelectItem value="created:asc">{tI18nComplete.raw('text6e2ebdab3c02')}</SelectItem>
            <SelectItem value="balance:desc">{tI18nComplete.raw('text7a274281b669')}</SelectItem>
            <SelectItem value="balance:asc">{tI18nComplete.raw('text6b1d152247c7')}</SelectItem>
            <SelectItem value="members:desc">{tI18nComplete.raw('text3d586b1705e4')}</SelectItem>
            <SelectItem value="members:asc">{tI18nComplete.raw('textf7da30470586')}</SelectItem>
            <SelectItem value="name:asc">{tI18nComplete.raw('text7ed96629073e')}</SelectItem>
            <SelectItem value="name:desc">{tI18nComplete.raw('texta5b2d1d78146')}</SelectItem>
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
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const tierOptions = useLocalizedUiCatalog(TIER_OPTIONS);
  const paymentStatusOptions = useLocalizedUiCatalog(PAYMENT_STATUS_OPTIONS);
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
        <span className="text-sm font-medium">{tI18nComplete.raw('text546ebb8eb993')}</span>
        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onReset}>
          {tI18nComplete.raw('text645982c52b7c')}
        </Button>
      </div>

      <div className="border-border space-y-2 border-b px-4 py-3">
        <div className="text-muted-foreground text-xs font-medium">
          {tI18nComplete.raw('text4999c6c6c7ba')}
        </div>
        <div className="flex items-center justify-between text-sm">
          <span>{tI18nComplete.raw('textf8ac87bcf3ff')}</span>
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
              <SelectItem value="any">{tI18nComplete.raw('text2b505597daa7')}</SelectItem>
              <SelectItem value="yes">{tI18nComplete.raw('text85a39ab345d6')}</SelectItem>
              <SelectItem value="no">{tI18nComplete.raw('text1ea442a134b2')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="border-border space-y-2 border-b px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="text-muted-foreground text-xs font-medium">
            {tI18nComplete.raw('textcb9e8664edea')}
          </div>
          {filters.tier.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-xs"
              onClick={() => onChange({ ...filters, tier: [] })}
            >
              {tI18nComplete.raw('text83b12c2216ef')}
            </Button>
          )}
        </div>
        <div className="space-y-1">
          {tierOptions.map((t, i) => (
            <div key={t.value}>
              {/* One heading, before the first grandfathered key — these are
                  still-honored plans no account can be moved onto today. */}
              {t.grandfathered && !tierOptions[i - 1]?.grandfathered && (
                <div className="text-muted-foreground px-1.5 pt-2 pb-1 text-xs">
                  {tI18nComplete.raw('text9d5adef979f7')}
                </div>
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
          <div className="text-muted-foreground text-xs font-medium">
            {tI18nComplete.raw('text272b5704fa54')}
          </div>
          {filters.paymentStatus.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-xs"
              onClick={() => onChange({ ...filters, paymentStatus: [] })}
            >
              {tI18nComplete.raw('text83b12c2216ef')}
            </Button>
          )}
        </div>
        <div className="space-y-1">
          {paymentStatusOptions.map((p) => (
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
        <div className="text-muted-foreground text-xs font-medium">
          {tI18nComplete.raw('textd05e07b7c14e')}
        </div>
        <div className="flex items-center gap-2">
          <Input
            type="number"
            value={minBalance}
            onChange={(e) => setMinBalance(e.target.value)}
            onBlur={commitBalances}
            placeholder={tI18nComplete.raw('textdea79332147f')}
            className="h-8 text-sm"
          />
          <span className="text-muted-foreground text-xs">
            {tI18nComplete.raw('text663ea1bfffe5')}
          </span>
          <Input
            type="number"
            value={maxBalance}
            onChange={(e) => setMaxBalance(e.target.value)}
            onBlur={commitBalances}
            placeholder={tI18nComplete.raw('texta1a5936d3b0f')}
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
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const tierOptions = useLocalizedUiCatalog(TIER_OPTIONS);
  const chips: Array<{ key: string; label: string; onRemove: () => void }> = [];

  if (searchInput) {
    chips.push({
      key: 'search',
      label: tI18nComplete('text32599ff9efb7', { value0: searchInput }),
      onRemove: () => onSearchChange(''),
    });
  }
  if (filters.paidOnly) {
    chips.push({
      key: 'paid',
      label: tI18nComplete.raw('text4eaea5edcdef'),
      onRemove: () => onChange({ ...filters, paidOnly: false }),
    });
  }
  for (const t of filters.tier) {
    chips.push({
      key: `tier:${t}`,
      label: tI18nComplete('text3ac9d50c270e', { value0: tierKeyLabel(t, tierOptions) }),
      onRemove: () => onChange({ ...filters, tier: filters.tier.filter((x) => x !== t) }),
    });
  }
  for (const p of filters.paymentStatus) {
    chips.push({
      key: `payment:${p}`,
      label: tI18nComplete('textdeb093603efa', { value0: p.replace(/_/g, ' ') }),
      onRemove: () =>
        onChange({ ...filters, paymentStatus: filters.paymentStatus.filter((x) => x !== p) }),
    });
  }
  if (filters.hasSubscription === true) {
    chips.push({
      key: 'sub',
      label: tI18nComplete.raw('textccdc59cf6178'),
      onRemove: () => onChange({ ...filters, hasSubscription: null }),
    });
  } else if (filters.hasSubscription === false) {
    chips.push({
      key: 'sub',
      label: tI18nComplete.raw('textb9da7e34f203'),
      onRemove: () => onChange({ ...filters, hasSubscription: null }),
    });
  }
  if (filters.minBalance !== null) {
    chips.push({
      key: 'min',
      label: tI18nComplete('textd9ef50b79c75', { value0: filters.minBalance }),
      onRemove: () => onChange({ ...filters, minBalance: null }),
    });
  }
  if (filters.maxBalance !== null) {
    chips.push({
      key: 'max',
      label: tI18nComplete('text5d4f8dc198f5', { value0: filters.maxBalance }),
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
          {tI18nComplete.raw('text29a390f9237e')}
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
        className="bg-background w-full overflow-y-auto p-0 sm:!max-w-[640px] md:!max-w-[820px] lg:!max-w-[1120px]"
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
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
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
        onError: (error) => errorToast(error.message || tI18nComplete.raw('text32d3603f57c7')),
      },
    );
  };

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} className="gap-1.5">
        <Eye className="h-3.5 w-3.5" />
        {tI18nComplete.raw('text2dbbf46b037e')}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={tI18nComplete('texta859c6f35e58', { value0: accountLabelFor(account) })}
        description={
          <span className="space-y-3">
            <span className="block">{tI18nComplete.raw('text25d302d271e6')}</span>
            <Input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder={tI18nComplete.raw('text21164ff9b63e')}
              maxLength={500}
            />
          </span>
        }
        confirmLabel={tI18nComplete.raw('text2dbbf46b037e')}
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
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
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
      errorToast(tI18nComplete.raw('text4cb23f3c3b90'));
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
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const usersQuery = useAdminAccountUsers(account.accountId);
  const projectsQuery = useAdminAccountProjects(account.accountId);
  const ledgerQuery = useAdminAccountLedger(account.accountId, 100);
  const actions = billingActionsFor(account, tI18nComplete);
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
                  {tI18nComplete.raw('text98a66e9745c9')}
                </Badge>
              )}
            </div>
          </div>
          <OpenAsAccountButton account={account} />
        </div>

        <SheetDescription className="sr-only">
          {tI18nComplete('text196a5c2c8297', { value0: accountLabelFor(account) })}
        </SheetDescription>

        {/* Identity: email and account id are both click-to-copy. */}
        <div className="flex flex-col items-start gap-1">
          <CopyField
            icon={Mail}
            value={account.ownerEmail}
            placeholder={tI18nComplete.raw('textaca82dbb8ef0')}
            label={tI18nComplete.raw('text82244417f956')}
          />
          <CopyField
            icon={IdentificationCardIcon}
            value={account.accountId}
            placeholder={tI18nComplete.raw('text6335879539ad')}
            label={tI18nComplete.raw('texte4bfff9b557b')}
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
            label={tI18nComplete.raw('text10ea22c4a146')}
            value={formatCredits(account.balance)}
            tone={balanceNegative ? 'danger' : 'default'}
          />
          <StatTile
            label={tI18nComplete.raw('textff44a401445c')}
            value={formatCredits(account.expiringCredits)}
          />
          <StatTile
            label={tI18nComplete.raw('text455a95491f40')}
            value={formatCredits(account.nonExpiringCredits)}
          />
          <StatTile
            label={tI18nComplete.raw('textb36c2611dcdf')}
            value={formatCredits(account.dailyCreditsBalance)}
          />
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
              {tI18nComplete.raw('text2a6b24ad2872')}
            </TabsTrigger>
            <TabsTrigger value="entitlements" className="w-fit flex-none gap-1.5">
              <Key className="size-3.5 shrink-0" />
              {tI18nComplete.raw('text2cc79c9e300d')}
            </TabsTrigger>
            <TabsTrigger value="users" className="w-fit flex-none gap-1.5">
              <Users className="size-3.5 shrink-0" />
              {tI18nComplete.raw('text6b0cc904d081')}
              {usersCount != null && (
                <Badge variant="secondary" size="sm">
                  {usersCount}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="projects" className="w-fit flex-none gap-1.5">
              <FolderKanban className="size-3.5 shrink-0" />
              {tI18nComplete.raw('text04e2a9728af7')}
              {projectsCount != null && (
                <Badge variant="secondary" size="sm">
                  {projectsCount}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="ledger" className="w-fit flex-none gap-1.5">
              <History className="size-3.5 shrink-0" />
              {tI18nComplete.raw('textee69eb4afc76')}
            </TabsTrigger>
            <TabsTrigger value="billing" className="w-fit flex-none gap-1.5">
              <Shield className="size-3.5 shrink-0" />
              {tI18nComplete.raw('text3ac8bbca9a74')}
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
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const tierOptions = useLocalizedUiCatalog(TIER_OPTIONS);
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
      errorToast(tI18nComplete.raw('texta9e82cd23e9d'));
      return;
    }
    try {
      await grant.mutateAsync({
        accountId: account.accountId,
        amount: parsed,
        description: description.trim() || 'Admin credit adjustment',
        isExpiring,
      });
      successToast(tI18nComplete.raw('text0268c03cd74c'), {
        description: tI18nComplete('text24dab51514a1', {
          value0: money(parsed),
          value1: accountLabelFor(account),
        }),
      });
      setAmount('');
    } catch (error) {
      errorToast(tI18nComplete.raw('text9538346557b5'), {
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
      successToast(tI18nComplete.raw('text3efd6742a383'), {
        description: tI18nComplete('text1836d8d61ae9', {
          value0: money(parsed),
          value1: accountLabelFor(account),
        }),
      });
      setAmount('');
    } catch (error) {
      errorToast(tI18nComplete.raw('text16cf9ca5c085'), {
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      setConfirmDebit(false);
    }
  }

  async function handleSetEnterprise(enabled: boolean) {
    try {
      await setEnterpriseEntitled.mutateAsync({ accountId: account.accountId, enabled });
      successToast(
        enabled ? tI18nComplete.raw('text4046f33a6c82') : tI18nComplete.raw('text7c0adcef1126'),
        {
          description: tI18nComplete('textb18320256e28', {
            value0: accountLabelFor(account),
            value1: enabled ? 'now has' : 'no longer has',
          }),
        },
      );
    } catch (error) {
      errorToast(tI18nComplete.raw('text3f3d54f50e6f'), {
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
            <div className="text-foreground text-sm font-medium">
              {tI18nComplete.raw('textfa8ed0bdabdd')}
            </div>
            <div className="text-muted-foreground text-xs">
              {tI18nComplete.raw('textc09f632874c2')}
              <span className="text-foreground font-medium">{planLabel(account, tierOptions)}</span>
              {account.plan?.sublabel ? ` · ${account.plan.sublabel}` : ''}
              {isEnterprise && tI18nComplete.raw('text70541b9b587b')}
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
            {isEnterprise
              ? tI18nComplete.raw('text2fe3e60fadc0')
              : tI18nComplete.raw('text991aa74eea34')}
          </Button>
          {isEnterprise && (
            <Button
              variant="outline"
              onClick={() => handleSetEnterprise(false)}
              disabled={setEnterpriseEntitled.isPending}
            >
              {tI18nComplete.raw('textbe99d500e83c')}
            </Button>
          )}
        </div>
        <p className="text-muted-foreground text-xs">{tI18nComplete.raw('texte65c84be34f9')}</p>
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
            placeholder={tI18nComplete.raw('text999d689b4739')}
            step="0.01"
          />
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={tI18nComplete.raw('text7477f5a7b656')}
          />
          <label className="text-muted-foreground flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isExpiring}
              onChange={(e) => setIsExpiring(e.target.checked)}
              className="size-4"
            />
            {tI18nComplete.raw('texta9141e58e179')}
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
            {tI18nComplete.raw('textfa31b7396679')}
          </Button>
          <Button
            variant="outline"
            onClick={() => setConfirmDebit(true)}
            disabled={!isValid || grant.isPending || debit.isPending}
            className="flex-1 gap-1.5"
          >
            <ArrowDownRight className="h-3.5 w-3.5" />
            {tI18nComplete.raw('textae224acb87e2')}
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmDebit}
        onOpenChange={setConfirmDebit}
        title={tI18nComplete.raw('text994cfce0cc98')}
        description={
          <div className="space-y-2 text-sm">
            <p>
              {tI18nComplete.raw('text5498f487a861')}{' '}
              <span className="text-foreground font-mono">{isValid ? money(parsed) : '—'}</span>{' '}
              {tI18nComplete.raw('text75857a458999')}
              <span className="font-medium">{accountLabelFor(account)}</span>.
            </p>
            <p className="text-muted-foreground text-xs">{tI18nComplete.raw('textfb9f1f579b54')}</p>
          </div>
        }
        confirmLabel={tI18nComplete.raw('textae224acb87e2')}
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
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const entitlementRows = useLocalizedUiCatalog(OVERRIDE_ENTITLEMENT_ROWS);
  const triStateOptions = useLocalizedUiCatalog(OVERRIDE_TRI_STATE_OPTIONS);
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
      successToast(tI18nComplete.raw('text214d79fdac84'), {
        description: describeOverridePatch(result.patch),
      });
    } catch (error) {
      errorToast(tI18nComplete.raw('text222b8d57e366'), {
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  const effectiveMultiplier = account.computeRateMultiplier;

  return (
    <div className="border-border bg-popover space-y-4 rounded-md border p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-foreground text-sm font-medium">
            {tI18nComplete.raw('text7f6e1f2662b4')}
          </div>
          <p className="text-muted-foreground mt-0.5 max-w-prose text-xs">
            {tI18nComplete.raw('textbc575e0055ab')}
          </p>
        </div>
        {dirty && (
          <Badge variant="kortix" size="sm">
            {tI18nComplete.raw('text9c80e8331a86')}
          </Badge>
        )}
      </div>

      <div className="border-border divide-border divide-y rounded-md border">
        {entitlementRows.map(({ key, title, description }) => (
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
                  {triStateOptions.map((option) => (
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
            title={tI18nComplete.raw('textdae85d16887b')}
            description={tI18nComplete.raw('textca41e8913ee7')}
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
              placeholder={tI18nComplete.raw('text197f9370a831')}
              className="h-8 w-[140px] tabular-nums"
              aria-label={tI18nComplete.raw('text016e549e6831')}
              value={draft.maxConcurrentSessions}
              disabled={setOverrides.isPending}
              onChange={(e) => setRow('maxConcurrentSessions', e.target.value)}
            />
          </EntitlementRow>
        </div>

        <div className="px-4 py-3">
          <EntitlementRow
            title={tI18nComplete.raw('text7349c7d2f496')}
            description={tI18nComplete.raw('texte077517dd17a')}
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
              aria-label={tI18nComplete.raw('texta6b6d1454df0')}
              value={draft.computeRateMultiplier}
              disabled={setOverrides.isPending}
              onChange={(e) => setRow('computeRateMultiplier', e.target.value)}
            />
          </EntitlementRow>
          {effectiveMultiplier !== undefined && (
            <p className="text-muted-foreground mt-2 text-xs">
              {tI18nComplete.raw('text888f1dba5133')}{' '}
              <span className="text-foreground tabular-nums">{effectiveMultiplier}×</span>{' '}
              {tI18nComplete.raw('text01b8c5ddf23f')}
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
          {tI18nComplete.raw('textc3238b71962f')}
        </Button>
        {dirty && (
          <Button
            variant="outline"
            onClick={() => setDraft(draftFromOverrides(stored))}
            disabled={setOverrides.isPending}
          >
            {tI18nComplete.raw('textdaee7606b339')}
          </Button>
        )}
      </div>
    </div>
  );
}

function EntitlementsTab({ account }: { account: AdminAccount }) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const tierOptions = useLocalizedUiCatalog(TIER_OPTIONS);
  const trialTierOptions = useLocalizedUiCatalog(TRIAL_TIER_OPTIONS);
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
      successToast(
        isActive ? tI18nComplete.raw('textb4c65ea8ef96') : tI18nComplete.raw('text98b6c1f78029'),
        {
          description: tI18nComplete('text6db974c8b732', {
            value0: accountLabel,
            value1: tierKeyLabel(tierKey, tierOptions),
            value2: parsedDuration,
          }),
        },
      );
      setNote('');
    } catch (error) {
      errorToast(tI18nComplete.raw('texte8ea82789107'), {
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  async function handleRevokeTrial() {
    try {
      await revokeTrial.mutateAsync({ accountId: account.accountId });
      successToast(tI18nComplete.raw('text34a6992c659a'), {
        description: tI18nComplete('text9e0449fd24b6', { value0: accountLabel }),
      });
    } catch (error) {
      errorToast(tI18nComplete.raw('text05da7af7e394'), {
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      setConfirmRevoke(false);
    }
  }

  async function handleManagedModels(override: boolean | null) {
    try {
      await setManagedModels.mutateAsync({ accountId: account.accountId, override });
      successToast(tI18nComplete.raw('text13811c334c6d'), {
        description:
          override === null
            ? 'The effective tier decides again.'
            : override
              ? 'Managed models forced on.'
              : 'Restricted to BYOK keys.',
      });
    } catch (error) {
      errorToast(tI18nComplete.raw('text278179d861e0'), {
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  async function handleEnterpriseDemo(enabled: boolean) {
    try {
      await setEnterpriseDemo.mutateAsync({ accountId: account.accountId, enabled });
      successToast(
        enabled ? tI18nComplete.raw('texta2225f18a62a') : tI18nComplete.raw('texta4007c748290'),
      );
    } catch (error) {
      errorToast(tI18nComplete.raw('textcb7d3df7dd59'), {
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  async function handleEnterpriseEntitled(enabled: boolean) {
    try {
      await setEnterpriseEntitled.mutateAsync({ accountId: account.accountId, enabled });
      successToast(
        enabled ? tI18nComplete.raw('text9bfe30eaa67e') : tI18nComplete.raw('text0d26dc67cdfe'),
      );
    } catch (error) {
      errorToast(tI18nComplete.raw('texte913f584c3bc'), {
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  const managedModelsChoices: { value: boolean | null; label: string }[] = [
    { value: null, label: tI18nComplete.raw('textb885c730262c') },
    { value: true, label: tI18nComplete.raw('textbde131e31c9e') },
    { value: false, label: tI18nComplete.raw('textf4fcd871d62d') },
  ];

  return (
    <div className="space-y-4">
      {/* Trial — an admin-issued overlay: the account BEHAVES as the trial tier
          until it ends, without touching credit_accounts.tier (Stripe owns
          that). Re-granting overwrites the window: extend = re-grant. */}
      <div className="border-border bg-popover space-y-4 rounded-md border p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-foreground text-sm font-medium">
              {tI18nComplete.raw('text98a66e9745c9')}
            </div>
            <p className="text-muted-foreground mt-0.5 text-xs">
              {tI18nComplete.raw('text92a15b76467d')}{' '}
              <span className="text-foreground">{tierKeyLabel(account.tier, tierOptions)}</span>.
            </p>
          </div>
          <Badge variant={trialBadgeVariant(trial?.status ?? null)} size="sm">
            {trial?.status ?? 'none'}
          </Badge>
        </div>

        {trial && trial.status !== 'none' ? (
          <div className="border-border divide-border grid grid-cols-1 divide-y rounded-md border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
            <div className="px-3 py-2.5">
              <div className="text-muted-foreground text-xs">
                {tI18nComplete.raw('textcb9e8664edea')}
              </div>
              <div className="mt-0.5 text-sm font-medium">
                {trial.tier ? tierKeyLabel(trial.tier, tierOptions) : '—'}
                {trial.seats != null && (
                  <span className="text-muted-foreground font-normal">
                    {' '}
                    · {trial.seats} {tI18nComplete.raw('text5d2c13d6f9fa')}
                    {trial.seats === 1 ? '' : 's'}
                  </span>
                )}
              </div>
            </div>
            {/* A revoked or converted trial keeps its original window for audit,
                and that window can still be in the future — so the countdown is
                only meaningful while the trial is active. */}
            <div className="px-3 py-2.5">
              <div className="text-muted-foreground text-xs">
                {isActive ? 'Ends' : tI18nComplete.raw('text108bff86a0eb')}
              </div>
              <div className="mt-0.5 text-sm font-medium">
                {isActive ? formatCountdown(trial.endsAt) : formatDateTime(trial.endsAt)}
              </div>
              {isActive && (
                <div className="text-muted-foreground text-xs">{formatDateTime(trial.endsAt)}</div>
              )}
            </div>
            <div className="px-3 py-2.5">
              <div className="text-muted-foreground text-xs">
                {tI18nComplete.raw('textecbc89cd37a0')}
              </div>
              <div className="mt-0.5 text-sm font-medium">{formatRelative(trial.startedAt)}</div>
              <div className="text-muted-foreground text-xs">{formatDateTime(trial.startedAt)}</div>
            </div>
          </div>
        ) : (
          <p className="text-muted-foreground text-xs">{tI18nComplete.raw('text1fd045f22dfd')}</p>
        )}

        {trial?.note && (
          <p className="text-muted-foreground border-border border-l-2 pl-3 text-xs">
            {trial.note}
          </p>
        )}

        {/* Grant / replace form */}
        <div className="border-border space-y-3 border-t pt-4">
          <div className="text-foreground text-sm font-medium">
            {isActive
              ? tI18nComplete.raw('text57579cf783f3')
              : tI18nComplete.raw('text8529ff665870')}
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            <div className="space-y-1">
              <label className="text-muted-foreground text-xs">
                {tI18nComplete.raw('textcb9e8664edea')}
              </label>
              <Select value={tierKey} onValueChange={setTierKey}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {trialTierOptions.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      <span>{t.label}</span>
                      <span className="text-muted-foreground ml-1.5 text-xs">{t.hint}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-muted-foreground text-xs">
                {tI18nComplete.raw('textf37a3ea11c91')}
              </p>
            </div>
            <div className="space-y-1">
              <label className="text-muted-foreground text-xs">
                {tI18nComplete.raw('textf3b81325942e')}
              </label>
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
              <label className="text-muted-foreground text-xs">
                {tI18nComplete.raw('text1f1196332022')}
              </label>
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
            <label className="text-muted-foreground text-xs">
              {tI18nComplete.raw('text4fc52a3c4c55')}
            </label>
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
                aria-label={tI18nComplete.raw('textbcd80dd21f3c')}
                aria-invalid={!durationValid}
                className="h-7 w-24"
              />
            </div>
          </div>

          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={tI18nComplete.raw('text7147a36979c2')}
            maxLength={2000}
          />

          <div className="flex flex-wrap gap-2">
            <Button
              onClick={handleGrantTrial}
              disabled={!formValid || grantTrial.isPending || revokeTrial.isPending}
              className="gap-1.5"
            >
              {grantTrial.isPending && <Loading className="h-3.5 w-3.5" />}
              {isActive
                ? tI18nComplete.raw('text57579cf783f3')
                : tI18nComplete.raw('text8529ff665870')}
            </Button>
            {isActive && (
              <Button
                variant="outline"
                onClick={() => setConfirmRevoke(true)}
                disabled={grantTrial.isPending || revokeTrial.isPending}
              >
                {tI18nComplete.raw('textd85abf75ffac')}
              </Button>
            )}
          </div>
          <p className="text-muted-foreground text-xs">{tI18nComplete.raw('text0a2ea173ab93')}</p>
        </div>
      </div>

      {/* Managed models override — tri-state, null restores tier control. */}
      <div className="border-border bg-popover space-y-3 rounded-md border p-4">
        <EntitlementRow
          title={tI18nComplete.raw('text92cd11d7f50e')}
          description={tI18nComplete.raw('textb89ec7e4cd95')}
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
          title={tI18nComplete.raw('textfdccb896a3a1')}
          description={tI18nComplete.raw('textc6f417d32fe6')}
        >
          <Switch
            checked={account.demoEnterprise}
            disabled={setEnterpriseDemo.isPending}
            onCheckedChange={handleEnterpriseDemo}
            aria-label={tI18nComplete.raw('text8c02ce3010aa')}
          />
        </EntitlementRow>

        <div className="border-border border-t pt-4">
          <EntitlementRow
            title={tI18nComplete.raw('texta7d1ea80d81f')}
            description={tI18nComplete.raw('text458cde86effb')}
          >
            <Switch
              checked={account.enterpriseEntitled}
              disabled={setEnterpriseEntitled.isPending}
              onCheckedChange={handleEnterpriseEntitled}
              aria-label={tI18nComplete.raw('text33cf107ab219')}
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
          <span className="text-muted-foreground text-xs">
            {tI18nComplete.raw('text266240ec402c')}
          </span>
          <span className="text-right font-medium">{account.billingModel || '—'}</span>
        </div>
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <span className="text-muted-foreground text-xs">
            {tI18nComplete.raw('textf3b81325942e')}
          </span>
          <span className="text-right font-medium">{account.seatCount ?? '—'}</span>
        </div>
      </div>

      <ConfirmDialog
        open={confirmRevoke}
        onOpenChange={setConfirmRevoke}
        title={tI18nComplete.raw('textd85abf75ffac')}
        description={
          <div className="space-y-2 text-sm">
            <p>
              <span className="font-medium">{accountLabel}</span>{' '}
              {tI18nComplete.raw('textfd8beb3c3acc')}{' '}
              <span className="text-foreground font-medium">
                {tierKeyLabel(account.tier, tierOptions)}
              </span>{' '}
              {tI18nComplete.raw('textb94207703902')}
            </p>
            <p className="text-muted-foreground text-xs">{tI18nComplete.raw('text05643520119a')}</p>
          </div>
        }
        confirmLabel={tI18nComplete.raw('textd85abf75ffac')}
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
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const setMemberRole = useAdminSetMemberRole();

  async function handleRoleChange(userId: string, email: string, role: AdminAccountMemberRole) {
    try {
      await setMemberRole.mutateAsync({ accountId, userId, role });
      successToast(tI18nComplete.raw('textd7baeba57734'), {
        description: tI18nComplete('text359215455ae1', { value0: email, value1: role }),
      });
    } catch (error) {
      errorToast(tI18nComplete.raw('texte4143613f121'), {
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  if (usersQuery.isLoading) {
    return (
      <div className="border-border bg-popover text-muted-foreground flex items-center gap-2 rounded-md border px-4 py-6 text-sm">
        <Loading className="size-4 shrink-0" />
        {tI18nComplete.raw('texta53ec7ac2a7b')}
      </div>
    );
  }

  const users = usersQuery.data?.users ?? [];
  if (users.length === 0) {
    return (
      <div className="border-border bg-popover rounded-md border">
        <EmptyState
          icon={IconInbox}
          title={tI18nComplete.raw('text404bfcea3d30')}
          description={tI18nComplete.raw('text94590e163d12')}
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
                    {tI18nComplete.raw('text97b7e2db799e')}
                  </Badge>
                )}
                {banned && (
                  <Badge variant="destructive" size="sm" className="gap-1">
                    <Ban className="size-3 shrink-0" />
                    {tI18nComplete.raw('text7b412527489f')}
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
                <span className="text-muted-foreground">
                  {tI18nComplete.raw('text20c37607a3b4')}
                </span>
                <span className="text-foreground">
                  {user.last_sign_in_at ? formatRelative(user.last_sign_in_at) : 'Never'}
                </span>
              </div>
              <div className="truncate">
                <span className="text-muted-foreground">
                  {tI18nComplete.raw('textd55e4ce78182')}
                </span>
                <span className="text-foreground">
                  {user.signed_up_at ? formatRelative(user.signed_up_at) : '—'}
                </span>
              </div>
              <div className="truncate">
                <span className="text-muted-foreground">
                  {tI18nComplete.raw('text672f1efd8b87')}
                </span>
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
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  if (projectsQuery.isLoading) {
    return (
      <div className="border-border bg-popover text-muted-foreground flex items-center gap-2 rounded-md border px-4 py-6 text-sm">
        <Loading className="size-4 shrink-0" />
        {tI18nComplete.raw('text6970a1ced73d')}
      </div>
    );
  }

  const projects = projectsQuery.data?.projects ?? [];
  if (projects.length === 0) {
    return (
      <div className="border-border bg-popover rounded-md border">
        <EmptyState
          icon={FolderKanban}
          title={tI18nComplete.raw('text4b3a077cc3f0')}
          description={tI18nComplete.raw('textbe60f64bd270')}
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
                  {project.activeSessionCount} {tI18nComplete.raw('text96879611650f')}
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
              <span className="text-muted-foreground">{tI18nComplete.raw('text7bb2d21db6dc')}</span>
              <span className="text-foreground">{project.sessionCount}</span>
            </div>
            <div className="truncate">
              <span className="text-muted-foreground">{tI18nComplete.raw('textade43e0f021f')}</span>
              <span className="text-foreground">
                {project.lastSessionAt ? formatRelative(project.lastSessionAt) : '—'}
              </span>
            </div>
            <div className="truncate">
              <span className="text-muted-foreground">{tI18nComplete.raw('text29d0051ddd19')}</span>
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
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  if (ledgerQuery.isLoading) {
    return (
      <div className="border-border bg-popover text-muted-foreground flex items-center gap-2 rounded-md border px-4 py-6 text-sm">
        <Loading className="size-4 shrink-0" />
        {tI18nComplete.raw('text2893925796c8')}
      </div>
    );
  }

  const entries = ledgerQuery.data?.entries ?? [];
  if (entries.length === 0) {
    return (
      <div className="border-border bg-popover rounded-md border">
        <EmptyState
          icon={IconInbox}
          title={tI18nComplete.raw('text1171c854cfa8')}
          description={tI18nComplete.raw('text866f4db9c935')}
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
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const actions = billingActionsFor(account, tI18nComplete);

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
    { label: tI18nComplete.raw('text919bb4cb2182'), value: account.accountId, href: null },
    {
      label: tI18nComplete.raw('text53f71e08be88'),
      value: account.stripeSubscriptionId,
      href: account.stripeSubscriptionId?.startsWith('sub_')
        ? stripeUrl('subscription', account.stripeSubscriptionId)
        : null,
    },
    {
      label: tI18nComplete.raw('text8f169be1ff6f'),
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
                    title={tI18nComplete.raw('textd1f9c6739594')}
                  >
                    <ServiceFavicon domain="stripe.com" className="h-3 w-3" />
                    {tI18nComplete.raw('texted077f3d8125')}
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

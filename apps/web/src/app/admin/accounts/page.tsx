'use client';

import { useTranslations } from 'next-intl';

import {
  ArrowDown,
  ArrowDownRight,
  ArrowUp,
  ArrowUpRight,
  Ban,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CreditCard,
  ExternalLink,
  Filter,
  FolderKanban,
  History,
  Loader2,
  Mail,
  RefreshCw,
  Shield,
  SlidersHorizontal,
  Users,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { IconInbox } from '@/components/ui/kortix-icons';
import { PageSearchBar } from '@/components/ui/page-search-bar';
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
import {
  useAdminAccountLedger,
  useAdminAccountProjects,
  useAdminAccountUsers,
  useAdminAccounts,
  useAdminDebitCredits,
  useAdminGrantCredits,
  useAdminSetTier,
  type AdminAccount,
  type AdminAccountsFilters,
  type AdminAccountsSortBy,
  type AdminAccountsSortDir,
} from '@/hooks/admin/use-admin-accounts';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

import { SectionContainer, SectionHeader, StatPill, StatRow } from '../_components/section-header';

const PAGE_SIZE = 50;
const REIMBURSEMENT_PRESETS = [5, 10, 25, 50, 100];

// Tiers & payment statuses surfaced in the filter UI. Current tiers first, then
// the hidden legacy tier_* plans. Keep these `value`s in sync with the canonical
// TIERS map in apps/api/src/billing/services/tiers.ts — `tierLabel` also renders
// account rows off this list, so a missing entry shows the raw tier key.
const TIER_OPTIONS: { value: string; label: string }[] = [
  { value: 'free', label: 'Free' },
  { value: 'pro', label: 'Pro' },
  { value: 'per_seat', label: 'Team' },
  { value: 'enterprise', label: 'Enterprise' },
  { value: 'tier_2_20', label: 'Plus (legacy)' },
  { value: 'tier_6_50', label: 'Pro (legacy)' },
  { value: 'tier_12_100', label: 'Business (legacy)' },
  { value: 'tier_25_200', label: 'Ultra (legacy)' },
  { value: 'tier_50_400', label: 'Enterprise (legacy)' },
  { value: 'tier_125_800', label: 'Scale (legacy)' },
  { value: 'tier_200_1000', label: 'Max (legacy)' },
  { value: 'tier_150_1200', label: 'Enterprise Max (legacy)' },
  { value: 'none', label: 'No plan' },
];

const PAYMENT_STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: 'active', label: 'Active' },
  { value: 'past_due', label: 'Past due' },
  { value: 'canceled', label: 'Canceled' },
  { value: 'unpaid', label: 'Unpaid' },
  { value: 'incomplete', label: 'Incomplete' },
  { value: 'trialing', label: 'Trialing' },
];

function useDebounce<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

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

function formatDateTime(value: string | null | undefined) {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function tierLabel(tier: string | null) {
  if (!tier) return 'No plan';
  return TIER_OPTIONS.find((t) => t.value === tier)?.label ?? tier;
}

function tierBadgeVariant(tier: string | null): React.ComponentProps<typeof Badge>['variant'] {
  if (!tier || tier === 'free' || tier === 'none') return 'muted';
  return 'info';
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
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [searchInput, setSearchInput] = useState('');
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
    <SectionContainer>
      <SectionHeader
        icon={Users}
        title="Accounts"
        description={tHardcodedUi.raw(
          'appAdminAccountsPage.line337JsxAttrDescriptionFilterSortAndInspectEveryAccountGrantOr',
        )}
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching}
            className="gap-1.5"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', isFetching && 'animate-spin')} />
            Refresh
          </Button>
        }
      />

      <StatRow>
        <StatPill
          label={tHardcodedUi.raw('appAdminAccountsPage.line354JsxAttrLabelTotalFiltered')}
          value={total.toLocaleString()}
          hint={filtersCount > 0 ? 'Matches current filters' : 'All accounts'}
        />
        <StatPill
          label="Paid"
          value={(summary?.paidCount ?? 0).toLocaleString()}
          tone="success"
          hint={tHardcodedUi.raw('appAdminAccountsPage.line362JsxAttrHintNonFreeTiers')}
        />
        <StatPill
          label={tHardcodedUi.raw('appAdminAccountsPage.line365JsxAttrLabelCreditsInSet')}
          value={formatCredits(summary?.totalCredits ?? 0)}
          hint={tHardcodedUi.raw('appAdminAccountsPage.line367JsxAttrHintSumOfBalances')}
        />
        <StatPill
          label={tHardcodedUi.raw('appAdminAccountsPage.line370JsxAttrLabelPastDue')}
          value={summary?.pastDueCount ?? 0}
          tone={(summary?.pastDueCount ?? 0) > 0 ? 'warning' : 'default'}
          hint={(summary?.pastDueCount ?? 0) > 0 ? 'Needs review' : 'All clear'}
        />
      </StatRow>

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
            <Skeleton key={i} className="h-12 w-full rounded-2xl" />
          ))}
        </div>
      ) : accounts.length === 0 ? (
        <div className="border-border/60 bg-card rounded-2xl border">
          <EmptyState
            icon={IconInbox}
            title={
              search || filtersCount > 0 ? 'No accounts match your filters' : 'No accounts yet'
            }
            description={
              search || filtersCount > 0
                ? 'Try adjusting filters or clearing the search.'
                : undefined
            }
            action={
              search || filtersCount > 0 ? (
                <Button variant="outline" size="sm" onClick={resetFilters}>
                  {tHardcodedUi.raw('appAdminAccountsPage.line409JsxTextClearFilters')}
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <div
          className={cn(
            'border-border/60 overflow-hidden rounded-2xl border transition-opacity',
            isFetching && 'opacity-70',
          )}
        >
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
                <TableHead>Tier</TableHead>
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
                      <div className="truncate text-sm font-medium">
                        {account.name || 'Unnamed account'}
                      </div>
                      <div className="text-muted-foreground truncate text-xs">
                        {account.ownerEmail || 'No owner email'}
                        <span className="mx-1.5 opacity-50">·</span>
                        <span className="font-mono">{account.accountId.slice(0, 8)}</span>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={tierBadgeVariant(account.tier)} size="sm">
                      {tierLabel(account.tier)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <span
                      className={cn(
                        'font-mono text-sm',
                        Number(account.balance ?? 0) < 0 && 'text-red-600 dark:text-red-400',
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
                    {account.createdAt
                      ? new Date(account.createdAt).toLocaleDateString('en-US', {
                          month: 'short',
                          day: 'numeric',
                          year: 'numeric',
                        })
                      : '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {pages > 1 && (
        <div className="text-muted-foreground flex items-center justify-between text-sm">
          <span>
            Page {page} of {pages} · {total.toLocaleString()} accounts
          </span>
          <div className="flex gap-1">
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1 px-2.5"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              Prev
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1 px-2.5"
              onClick={() => setPage((p) => Math.min(pages, p + 1))}
              disabled={page === pages}
            >
              Next
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}

      <AccountDetailSheet account={selected} onClose={() => setSelected(null)} />
    </SectionContainer>
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
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <PageSearchBar
        value={searchInput}
        onChange={onSearchChange}
        placeholder={tHardcodedUi.raw(
          'appAdminAccountsPage.line580JsxAttrPlaceholderSearchByAccountOwnerEmailOrAccountId',
        )}
      />

      <div className="flex flex-wrap items-center gap-2">
        <label className="border-input bg-card flex h-9 items-center gap-2 rounded-2xl border px-3 py-1.5 text-sm">
          <Switch
            checked={filters.paidOnly}
            onCheckedChange={(v) => onFiltersChange({ ...filters, paidOnly: v })}
            aria-label={tHardcodedUi.raw(
              'appAdminAccountsPage.line588JsxAttrAriaLabelPaidAccountsOnly',
            )}
          />
          <span className="text-sm">
            {tHardcodedUi.raw('appAdminAccountsPage.line590JsxTextPaidOnly')}
          </span>
        </label>

        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="h-9 gap-1.5">
              <Filter className="h-3.5 w-3.5" />
              Filters
              {filtersCount > 0 && (
                <Badge variant="muted" size="sm" className="ml-1">
                  {filtersCount}
                </Badge>
              )}
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
          <SelectTrigger className="h-9 w-[170px] gap-1.5">
            <SlidersHorizontal className="text-muted-foreground h-3.5 w-3.5" />
            <SelectValue placeholder="Sort" />
          </SelectTrigger>
          <SelectContent align="end">
            <SelectItem value="created:desc">
              {tHardcodedUi.raw('appAdminAccountsPage.line622JsxTextNewestFirst')}
            </SelectItem>
            <SelectItem value="created:asc">
              {tHardcodedUi.raw('appAdminAccountsPage.line623JsxTextOldestFirst')}
            </SelectItem>
            <SelectItem value="balance:desc">
              {tHardcodedUi.raw('appAdminAccountsPage.line624JsxTextBalanceHigh')}
            </SelectItem>
            <SelectItem value="balance:asc">
              {tHardcodedUi.raw('appAdminAccountsPage.line625JsxTextBalanceLow')}
            </SelectItem>
            <SelectItem value="members:desc">
              {tHardcodedUi.raw('appAdminAccountsPage.line626JsxTextMostMembers')}
            </SelectItem>
            <SelectItem value="members:asc">
              {tHardcodedUi.raw('appAdminAccountsPage.line627JsxTextFewestMembers')}
            </SelectItem>
            <SelectItem value="name:asc">
              {tHardcodedUi.raw('appAdminAccountsPage.line628JsxTextNameAZ')}
            </SelectItem>
            <SelectItem value="name:desc">
              {tHardcodedUi.raw('appAdminAccountsPage.line629JsxTextNameZA')}
            </SelectItem>
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
  const tHardcodedUi = useTranslations('hardcodedUi');
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
      <div className="border-border/60 flex items-center justify-between border-b px-4 py-3">
        <span className="text-sm font-medium">Filters</span>
        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onReset}>
          {tHardcodedUi.raw('appAdminAccountsPage.line689JsxTextResetAll')}
        </Button>
      </div>

      <div className="border-border/60 space-y-2 border-b px-4 py-3">
        <div className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
          Subscription
        </div>
        <div className="flex items-center justify-between text-sm">
          <span>
            {tHardcodedUi.raw('appAdminAccountsPage.line698JsxTextHasActiveSubscription')}
          </span>
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

      <div className="border-border/60 space-y-2 border-b px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
            Tier
          </div>
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
          {TIER_OPTIONS.map((t) => (
            <label
              key={t.value}
              className="hover:bg-muted/40 flex cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1 text-sm"
            >
              <Checkbox
                checked={filters.tier.includes(t.value)}
                onCheckedChange={() => toggleTier(t.value)}
              />
              <span className="flex-1">{t.label}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="border-border/60 space-y-2 border-b px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
            {tHardcodedUi.raw('appAdminAccountsPage.line761JsxTextPaymentStatus')}
          </div>
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
              className="hover:bg-muted/40 flex cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1 text-sm"
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
        <div className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
          Balance
        </div>
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
  const tHardcodedUi = useTranslations('hardcodedUi');
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
      label: `Tier: ${tierLabel(t)}`,
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
        <button
          key={chip.key}
          type="button"
          onClick={chip.onRemove}
          className="group border-border/60 bg-muted/30 hover:bg-muted/60 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors"
        >
          <span>{chip.label}</span>
          <X className="text-muted-foreground group-hover:text-foreground h-3 w-3" />
        </button>
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
          {tHardcodedUi.raw('appAdminAccountsPage.line913JsxTextClearAll')}
        </Button>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sortable table header
// ─────────────────────────────────────────────────────────────────────────────

function SortHeader({
  label,
  column,
  sortBy,
  sortDir,
  onSort,
  align = 'left',
}: {
  label: string;
  column: AdminAccountsSortBy;
  sortBy: AdminAccountsSortBy;
  sortDir: AdminAccountsSortDir;
  onSort: (col: AdminAccountsSortBy) => void;
  align?: 'left' | 'right';
}) {
  const active = sortBy === column;
  return (
    <TableHead className={align === 'right' ? 'text-right' : ''}>
      <button
        type="button"
        onClick={() => onSort(column)}
        className={cn(
          'inline-flex items-center gap-1 text-xs font-medium tracking-wider uppercase transition-colors',
          active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
        )}
      >
        {label}
        {active ? (
          sortDir === 'asc' ? (
            <ArrowUp className="h-3 w-3" />
          ) : (
            <ArrowDown className="h-3 w-3" />
          )
        ) : (
          <ArrowDown className="h-3 w-3 opacity-0" />
        )}
      </button>
    </TableHead>
  );
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
  return (
    <Sheet open={!!account} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        className="w-full overflow-y-auto p-0 sm:!max-w-[640px] md:!max-w-[820px] lg:!max-w-[960px]"
      >
        {account && <AccountDetail account={account} />}
      </SheetContent>
    </Sheet>
  );
}

function AccountDetail({ account }: { account: AdminAccount }) {
  const usersQuery = useAdminAccountUsers(account.accountId);
  const projectsQuery = useAdminAccountProjects(account.accountId);
  const ledgerQuery = useAdminAccountLedger(account.accountId, 100);
  const actions = billingActionsFor(account);

  return (
    <div className="flex flex-col">
      <SheetHeader className="border-border/60 border-b p-6">
        <SheetTitle className="flex items-center gap-2 text-lg">
          {account.name || 'Unnamed account'}
          <Badge variant={tierBadgeVariant(account.tier)} size="sm">
            {tierLabel(account.tier)}
          </Badge>
          {account.paymentStatus && account.paymentStatus !== 'active' && (
            <Badge
              variant={paymentStatusBadge(account.paymentStatus)}
              size="sm"
              className="capitalize"
            >
              {account.paymentStatus.replace(/_/g, ' ')}
            </Badge>
          )}
        </SheetTitle>
        <SheetDescription className="flex flex-col gap-0.5 text-left">
          <span className="flex items-center gap-1.5 text-xs">
            <Mail className="h-3 w-3" />
            {account.ownerEmail || 'No owner email'}
          </span>
          <span className="font-mono text-xs">{account.accountId}</span>
        </SheetDescription>
        {actions.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pt-3">
            {actions.map((a) => (
              <a
                key={a.href}
                href={a.href}
                target="_blank"
                rel="noopener noreferrer"
                className="group border-border/60 bg-card text-foreground hover:bg-muted/40 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors"
              >
                <ServiceFavicon domain={a.domain} />
                {a.label}
                <ExternalLink className="text-muted-foreground/60 group-hover:text-foreground h-3 w-3" />
              </a>
            ))}
          </div>
        )}
      </SheetHeader>

      <div className="space-y-6 p-6">
        <StatRow className="!grid-cols-2 lg:!grid-cols-4">
          <StatPill label="Total" value={formatCredits(account.balance)} />
          <StatPill label="Expiring" value={formatCredits(account.expiringCredits)} />
          <StatPill label="Permanent" value={formatCredits(account.nonExpiringCredits)} />
          <StatPill label="Daily" value={formatCredits(account.dailyCreditsBalance)} />
        </StatRow>

        <Tabs defaultValue="credits" className="w-full">
          <TabsList className="h-auto w-full flex-wrap">
            <TabsTrigger value="credits" className="gap-1.5">
              <CreditCard className="h-3.5 w-3.5" />
              Credits
            </TabsTrigger>
            <TabsTrigger value="users" className="gap-1.5">
              <Users className="h-3.5 w-3.5" />
              Users
              {usersQuery.data?.users && (
                <Badge variant="muted" size="sm">
                  {usersQuery.data.users.length}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="projects" className="gap-1.5">
              <FolderKanban className="h-3.5 w-3.5" />
              Projects
              {projectsQuery.data?.projects && (
                <Badge variant="muted" size="sm">
                  {projectsQuery.data.projects.length}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="ledger" className="gap-1.5">
              <History className="h-3.5 w-3.5" />
              Ledger
            </TabsTrigger>
            <TabsTrigger value="billing" className="gap-1.5">
              <Shield className="h-3.5 w-3.5" />
              Billing
            </TabsTrigger>
          </TabsList>

          <TabsContent value="credits" className="mt-4">
            <CreditsTab account={account} />
          </TabsContent>
          <TabsContent value="users" className="mt-4">
            <UsersTab usersQuery={usersQuery} />
          </TabsContent>
          <TabsContent value="projects" className="mt-4">
            <ProjectsTab projectsQuery={projectsQuery} />
          </TabsContent>
          <TabsContent value="ledger" className="mt-4">
            <LedgerTab ledgerQuery={ledgerQuery} />
          </TabsContent>
          <TabsContent value="billing" className="mt-4">
            <BillingTab account={account} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

function CreditsTab({ account }: { account: AdminAccount }) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const tHardcodedUi = useTranslations('hardcodedUi');
  const grant = useAdminGrantCredits();
  const debit = useAdminDebitCredits();
  const setTier = useAdminSetTier();
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('Reimbursement');
  const [isExpiring, setIsExpiring] = useState(false);
  const [confirmDebit, setConfirmDebit] = useState(false);

  const parsed = Number(amount);
  const isValid = Number.isFinite(parsed) && parsed > 0;

  async function handleGrant() {
    if (!isValid) {
      toast.error('Enter a valid positive amount');
      return;
    }
    try {
      await grant.mutateAsync({
        accountId: account.accountId,
        amount: parsed,
        description: description.trim() || 'Admin credit adjustment',
        isExpiring,
      });
      toast.success('Credits granted', {
        description: `${money(parsed)} added to ${account.name || account.accountId}`,
      });
      setAmount('');
    } catch (error) {
      toast.error('Failed to grant credits', {
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
      toast.success('Credits debited', {
        description: `${money(parsed)} removed from ${account.name || account.accountId}`,
      });
      setAmount('');
    } catch (error) {
      toast.error('Failed to debit credits', {
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      setConfirmDebit(false);
    }
  }

  async function handleSetTier(tier: string, label: string) {
    try {
      await setTier.mutateAsync({ accountId: account.accountId, tier });
      toast.success(`Plan set to ${label}`, {
        description: `${account.name || account.accountId} is now on ${label}.`,
      });
    } catch (error) {
      toast.error('Failed to set plan', {
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  const isEnterprise = account.tier === 'enterprise';

  return (
    <>
      {/* Plan / Enterprise activation — sales-assigned tiers have no self-serve
          path; this flips the account onto Enterprise (unlocks SSO + SCIM). */}
      <div className="border-border/60 bg-card mb-4 space-y-3 rounded-2xl border p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-foreground text-sm font-medium">Plan</div>
            <div className="text-muted-foreground text-xs">
              Current:{' '}
              <span className="text-foreground font-medium">{tierLabel(account.tier)}</span>
              {isEnterprise && ' · SSO + SCIM unlocked'}
            </div>
          </div>
          <Badge variant={tierBadgeVariant(account.tier)} className="capitalize">
            {tierLabel(account.tier)}
          </Badge>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => handleSetTier('enterprise', 'Enterprise')}
            disabled={setTier.isPending || isEnterprise}
            className="gap-1.5"
          >
            {setTier.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {isEnterprise ? 'Enterprise active' : 'Activate Enterprise'}
          </Button>
          {isEnterprise && (
            <Button
              variant="outline"
              onClick={() => handleSetTier('per_seat', 'Team')}
              disabled={setTier.isPending}
            >
              {tI18nHardcoded.raw('autoAppAdminAccountsPageJsxTextRevertToTeam5247682b')}
            </Button>
          )}
        </div>
        <p className="text-muted-foreground text-xs">
          {tI18nHardcoded.raw('autoAppAdminAccountsPageJsxTextEnterpriseUnlocksSAMLSSO7daa7fe0')}
        </p>
      </div>

      <div className="border-border/60 bg-card space-y-4 rounded-2xl border p-4">
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
            placeholder={tHardcodedUi.raw(
              'appAdminAccountsPage.line1161JsxAttrPlaceholderAmountEG25',
            )}
            step="0.01"
          />
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={tHardcodedUi.raw(
              'appAdminAccountsPage.line1167JsxAttrPlaceholderReasonNote',
            )}
          />
          <label className="text-muted-foreground flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isExpiring}
              onChange={(e) => setIsExpiring(e.target.checked)}
              className="size-4"
            />
            {tHardcodedUi.raw('appAdminAccountsPage.line1176JsxTextGrantAsExpiringCredits')}
          </label>
        </div>
        <div className="flex gap-2">
          <Button
            onClick={handleGrant}
            disabled={!isValid || grant.isPending || debit.isPending}
            className="flex-1 gap-1.5"
          >
            {grant.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ArrowUpRight className="h-3.5 w-3.5" />
            )}
            {tHardcodedUi.raw('appAdminAccountsPage.line1190JsxTextGrantCredits')}
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
        title={tHardcodedUi.raw('appAdminAccountsPage.line1207JsxAttrTitleDebitCredits')}
        description={
          <div className="space-y-2 text-sm">
            <p>
              Deduct{' '}
              <span className="text-foreground font-mono">{isValid ? money(parsed) : '—'}</span>{' '}
              from <span className="font-medium">{account.name || account.accountId}</span>.
            </p>
            <p className="text-muted-foreground text-xs">
              {tHardcodedUi.raw(
                'appAdminAccountsPage.line1215JsxTextWillFailIfTheAccountHasInsufficientCredits',
              )}
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

function UsersTab({ usersQuery }: { usersQuery: ReturnType<typeof useAdminAccountUsers> }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  if (usersQuery.isLoading) {
    return (
      <div className="border-border/60 bg-card text-muted-foreground flex items-center gap-2 rounded-2xl border px-4 py-6 text-sm">
        <Loader2 className="h-4 w-4 animate-spin" />
        {tHardcodedUi.raw('appAdminAccountsPage.line1236JsxTextLoadingUsers')}
      </div>
    );
  }

  const users = usersQuery.data?.users ?? [];
  if (users.length === 0) {
    return (
      <div className="border-border/60 bg-card rounded-2xl border">
        <EmptyState
          icon={IconInbox}
          title={tHardcodedUi.raw('appAdminAccountsPage.line1247JsxAttrTitleNoUsersOnThisAccount')}
          description={tHardcodedUi.raw(
            'appAdminAccountsPage.line1248JsxAttrDescriptionMembersWillAppearHereOnceUsersAreAdded',
          )}
          size="sm"
        />
      </div>
    );
  }

  return (
    <div className="border-border/60 bg-card divide-border/60 divide-y rounded-2xl border">
      {users.map((user) => {
        const banned = user.banned_until && new Date(user.banned_until) > new Date();
        const confirmed = !!user.email_confirmed_at;
        return (
          <div key={user.user_id} className="flex flex-col gap-2 px-4 py-3 text-sm">
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate font-medium">{user.email}</span>
                {confirmed ? (
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                ) : (
                  <Badge variant="warning" size="sm">
                    unverified
                  </Badge>
                )}
                {banned && (
                  <Badge variant="destructive" size="sm" className="gap-1">
                    <Ban className="h-3 w-3" />
                    banned
                  </Badge>
                )}
              </div>
              <Badge variant="muted" size="sm" className="shrink-0 capitalize">
                {user.account_role}
              </Badge>
            </div>
            <div className="text-muted-foreground grid grid-cols-2 gap-2 text-xs">
              <div className="truncate">
                <span className="text-muted-foreground/70">
                  {tHardcodedUi.raw('appAdminAccountsPage.line1285JsxTextLastSignIn')}
                </span>
                <span className="text-foreground/80">
                  {user.last_sign_in_at ? formatRelative(user.last_sign_in_at) : 'Never'}
                </span>
              </div>
              <div className="truncate">
                <span className="text-muted-foreground/70">
                  {tHardcodedUi.raw('appAdminAccountsPage.line1291JsxTextSignedUp')}
                </span>
                <span className="text-foreground/80">
                  {user.signed_up_at ? formatRelative(user.signed_up_at) : '—'}
                </span>
              </div>
              <div className="truncate">
                <span className="text-muted-foreground/70">Provider: </span>
                <span className="text-foreground/80 capitalize">{user.provider || '—'}</span>
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
      <div className="border-border/60 bg-card text-muted-foreground flex items-center gap-2 rounded-2xl border px-4 py-6 text-sm">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading projects…
      </div>
    );
  }

  const projects = projectsQuery.data?.projects ?? [];
  if (projects.length === 0) {
    return (
      <div className="border-border/60 bg-card rounded-2xl border">
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
    <div className="border-border/60 bg-card divide-border divide-y rounded-2xl border">
      {projects.map((project) => (
        <a
          key={project.projectId}
          href={`/projects/${project.projectId}`}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:bg-muted/40 flex flex-col gap-2 px-4 py-3 text-sm transition-colors"
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
            <ExternalLink className="text-muted-foreground/60 h-3.5 w-3.5 shrink-0" />
          </div>
          <div className="text-muted-foreground grid grid-cols-2 gap-2 text-xs">
            <div className="truncate">
              <span className="text-muted-foreground/70">Sessions: </span>
              <span className="text-foreground/80">{project.sessionCount}</span>
            </div>
            <div className="truncate">
              <span className="text-muted-foreground/70">Last activity: </span>
              <span className="text-foreground/80">
                {project.lastSessionAt ? formatRelative(project.lastSessionAt) : '—'}
              </span>
            </div>
            <div className="truncate">
              <span className="text-muted-foreground/70">Updated: </span>
              <span className="text-foreground/80">{formatRelative(project.updatedAt)}</span>
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
  const tHardcodedUi = useTranslations('hardcodedUi');
  if (ledgerQuery.isLoading) {
    return (
      <div className="border-border/60 bg-card text-muted-foreground flex items-center gap-2 rounded-2xl border px-4 py-6 text-sm">
        <Loader2 className="h-4 w-4 animate-spin" />
        {tHardcodedUi.raw('appAdminAccountsPage.line1331JsxTextLoadingLedger')}
      </div>
    );
  }

  const entries = ledgerQuery.data?.entries ?? [];
  if (entries.length === 0) {
    return (
      <div className="border-border/60 bg-card rounded-2xl border">
        <EmptyState
          icon={IconInbox}
          title={tHardcodedUi.raw('appAdminAccountsPage.line1342JsxAttrTitleNoLedgerEntries')}
          description={tHardcodedUi.raw(
            'appAdminAccountsPage.line1343JsxAttrDescriptionCreditActivityWillShowUpHere',
          )}
          size="sm"
        />
      </div>
    );
  }

  return (
    <div className="border-border/60 bg-card divide-border/60 max-h-[50vh] divide-y overflow-y-auto rounded-2xl border">
      {entries.map((entry) => {
        const amount = Number(entry.amount);
        const positive = amount >= 0;
        return (
          <div key={entry.id} className="flex items-start justify-between gap-3 px-4 py-3 text-sm">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Badge variant="muted" size="sm" className="capitalize">
                  {entry.type.replace(/_/g, ' ')}
                </Badge>
                {entry.isExpiring && (
                  <Badge variant="warning" size="sm">
                    expiring
                  </Badge>
                )}
              </div>
              {entry.description && (
                <div className="text-muted-foreground mt-1 line-clamp-2 text-xs">
                  {entry.description}
                </div>
              )}
              <div className="text-muted-foreground mt-0.5 text-xs">
                {formatDateTime(entry.createdAt)}
              </div>
            </div>
            <div className="shrink-0 text-right">
              <div
                className={cn(
                  'font-mono text-sm font-medium',
                  positive
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : 'text-red-600 dark:text-red-400',
                )}
              >
                {positive ? '+' : '-'}
                {money(amount)}
              </div>
              <div className="text-muted-foreground font-mono text-xs">
                → {formatCredits(entry.balanceAfter)}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function BillingTab({ account }: { account: AdminAccount }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const actions = billingActionsFor(account);

  const summary: Array<[string, React.ReactNode]> = [
    [
      'Tier',
      <Badge key="tier" variant={tierBadgeVariant(account.tier)} size="sm">
        {tierLabel(account.tier)}
      </Badge>,
    ],
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
              className="group border-border/60 bg-card hover:bg-muted/40 inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors"
            >
              <ServiceFavicon domain={a.domain} />
              {a.label}
              <ExternalLink className="text-muted-foreground/60 group-hover:text-foreground h-3 w-3" />
            </a>
          ))}
        </div>
      )}

      <div className="border-border/60 bg-card rounded-2xl border text-sm">
        <div className="divide-border/60 grid grid-cols-1 divide-y sm:grid-cols-2 sm:divide-x sm:divide-y-0">
          {summary.map(([label, value]) => (
            <div key={label} className="flex items-center justify-between gap-3 px-4 py-3">
              <span className="text-muted-foreground/70 text-xs tracking-wider uppercase">
                {label}
              </span>
              <span className="text-right font-medium">{value}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="border-border/60 bg-card divide-border/60 divide-y rounded-2xl border text-sm">
        {idRows.map(({ label, value, href }) => (
          <div
            key={label}
            className="flex flex-col gap-1 px-4 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-6"
          >
            <span className="text-muted-foreground/70 shrink-0 text-xs tracking-wider uppercase sm:w-40">
              {label}
            </span>
            {value ? (
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <code className="text-foreground/90 bg-muted/30 min-w-0 flex-1 rounded px-2 py-1 font-mono text-xs break-all">
                  {value}
                </code>
                {href && (
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="border-border/60 bg-card text-muted-foreground hover:bg-muted/40 hover:text-foreground inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-1 text-xs font-medium transition-colors"
                    title={tHardcodedUi.raw(
                      'appAdminAccountsPage.line1495JsxAttrTitleOpenInStripe',
                    )}
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

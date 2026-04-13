'use client';

import { useState } from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { FilterBar, FilterBarItem } from '@/components/ui/tabs';
import {
  RefreshCw,
  CreditCard,
  Zap,
  ArrowDownCircle,
  RotateCcw,
  CalendarSync,
  Clock,
  ChevronLeft,
  ChevronRight,
  Receipt,
  Loader2,
} from 'lucide-react';
import { useTransactions } from '@/hooks/billing/use-transactions';
import { cn } from '@/lib/utils';
import { creditsToDollars } from '@kortix/shared';

type FilterTab = 'all' | 'topups' | 'subscription' | 'refunds';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDate(dateString: string) {
  return new Date(dateString).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDollars(credits: number): string {
  const dollars = Math.abs(creditsToDollars(credits));
  if (dollars === 0) return '$0.00';
  if (dollars < 0.01) return '< $0.01';
  return `$${dollars.toFixed(2)}`;
}

// ─── Type config ─────────────────────────────────────────────────────────────

interface TypeConfig {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  category: FilterTab;
  detail: string;
}

const TYPE_CONFIG: Record<string, TypeConfig> = {
  tier_grant:    { label: 'Subscription',    icon: CalendarSync,    category: 'subscription', detail: 'Monthly plan' },
  daily_refresh: { label: 'Daily Refresh',   icon: RotateCcw,       category: 'all',          detail: 'Refresh' },
  purchase:      { label: 'Credit Purchase', icon: CreditCard,      category: 'topups',       detail: 'One-time purchase' },
  auto_topup:    { label: 'Auto Top-up',     icon: RotateCcw,       category: 'topups',       detail: 'Automatic top-up' },
  machine_bonus: { label: 'Machine Bonus',   icon: Zap,             category: 'topups',       detail: 'Free credits' },
  refund:        { label: 'Refund',          icon: ArrowDownCircle, category: 'refunds',      detail: 'Refund' },
  adjustment:    { label: 'Adjustment',      icon: Zap,             category: 'all',          detail: 'Adjustment' },
  expired:       { label: 'Expired',         icon: Clock,           category: 'all',          detail: 'Expired' },
};

function getConfig(type: string): TypeConfig {
  return TYPE_CONFIG[type] ?? { label: type, icon: Receipt, category: 'all' as FilterTab, detail: 'Payment' };
}

const PAYMENT_TYPES = ['purchase', 'auto_topup', 'tier_grant', 'machine_bonus', 'refund'] as const;
function isPaymentType(type: string) { return PAYMENT_TYPES.includes(type as (typeof PAYMENT_TYPES)[number]); }

// ─── Component ───────────────────────────────────────────────────────────────

const LIMIT = 50;

const FILTER_TABS: { id: FilterTab; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'topups', label: 'Top-ups' },
  { id: 'subscription', label: 'Subscription' },
  { id: 'refunds', label: 'Refunds' },
];

export default function BillingHistory() {
  const [tab, setTab] = useState<FilterTab>('all');
  const [offset, setOffset] = useState(0);

  const { data, isLoading, error, refetch, isRefetching } = useTransactions(LIMIT, offset, [...PAYMENT_TYPES]);

  const allTx = (data?.transactions ?? []).filter((tx) => isPaymentType(tx.type));
  const transactions = allTx.filter((tx) => {
    if (tab === 'all') return true;
    return getConfig(tx.type).category === tab;
  });

  if (isLoading && offset === 0) {
    return (
      <div className="space-y-3">
        <div className="grid grid-cols-3 gap-3">
          {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-14 rounded-lg" />)}
        </div>
        <div className="space-y-1">
          {[...Array(6)].map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-destructive px-4 py-3">
        <p className="text-sm text-destructive">{(error as Error).message || 'Failed to load history'}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Filters + refresh */}
      <div className="flex items-center justify-between">
        <FilterBar>
          {FILTER_TABS.map((t) => (
            <FilterBarItem
              key={t.id}
              value={t.id}
              onClick={() => { setTab(t.id); setOffset(0); }}
              data-state={tab === t.id ? 'active' : 'inactive'}
            >
              {t.label}
            </FilterBarItem>
          ))}
        </FilterBar>
        <Button
          onClick={() => refetch()}
          variant="ghost"
          size="icon-sm"
        >
          {isRefetching ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
        </Button>
      </div>

      {/* Table */}
      {transactions.length === 0 ? (
        <div className="py-12 text-center">
          <Receipt className="size-6 text-muted-foreground mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">No billing events</p>
          <p className="text-xs text-muted-foreground mt-1">
            {tab !== 'all' ? 'Try "All" to see everything' : 'Charges and refunds will appear here'}
          </p>
        </div>
      ) : (
        <>
          <div className="overflow-hidden rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="px-3 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Date</TableHead>
                  <TableHead className="px-3 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Type</TableHead>
                  <TableHead className="px-3 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Details</TableHead>
                  <TableHead className="px-3 text-right text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {transactions.map((tx) => {
                  const config = getConfig(tx.type);
                  const Icon = config.icon;
                  const isRefund = tx.type === 'refund';

                  return (
                    <TableRow key={tx.id} className="hover:bg-muted/30">
                      <TableCell className="px-3 py-2.5 text-xs text-muted-foreground font-mono tabular-nums whitespace-nowrap">
                        {formatDate(tx.created_at)}
                      </TableCell>
                      <TableCell className="px-3 py-2.5">
                        <div className="flex items-center gap-1.5">
                          <Icon className="size-3.5 text-muted-foreground shrink-0" />
                          <span className="text-xs font-medium text-foreground whitespace-nowrap">{config.label}</span>
                        </div>
                      </TableCell>
                      <TableCell className="px-3 py-2.5">
                        <p className="text-xs text-muted-foreground truncate max-w-[200px]">
                          {tx.description || config.detail}
                        </p>
                      </TableCell>
                      <TableCell className="px-3 py-2.5 text-right">
                        <span className={cn(
                          'text-xs font-medium tabular-nums',
                          isRefund ? 'text-emerald-600 dark:text-green-400' : 'text-foreground',
                        )}>
                          {isRefund ? '+' : ''}{formatDollars(tx.amount)}
                        </span>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>

          {/* Pagination */}
          {data?.pagination && (
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">
                {offset + 1}–{Math.min(offset + LIMIT, data.pagination.total)} of {data.pagination.total}
              </p>
              <div className="flex items-center gap-1">
                <Button variant="outline" size="sm" className="h-7 px-2" onClick={() => setOffset(Math.max(0, offset - LIMIT))} disabled={offset === 0}>
                  <ChevronLeft className="size-3" />
                </Button>
                <Button variant="outline" size="sm" className="h-7 px-2" onClick={() => setOffset(offset + LIMIT)} disabled={!data.pagination.has_more}>
                  <ChevronRight className="size-3" />
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

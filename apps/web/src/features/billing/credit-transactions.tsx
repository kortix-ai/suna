'use client';

import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { CreditTransactionsTable } from '@/features/billing/transactions-table';
import { useTransactions } from '@/hooks/billing/use-transactions';
import { isBillingEnabled } from '@/lib/config';
import { CoinsIcon as Coins, ArrowClockwiseIcon as RefreshCw } from '@phosphor-icons/react';
import { useState } from 'react';

interface Props {
  accountId?: string;
}

export default function CreditTransactions({ accountId }: Props) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [offset, setOffset] = useState(0);
  const [typeFilter, setTypeFilter] = useState<string | undefined>(undefined);
  const limit = 50;
  const billingActive = isBillingEnabled();

  // Billing disabled on this deployment (e.g. self-host with
  // KORTIX_BILLING_INTERNAL_ENABLED=false): there is no credit ledger to show.
  // Skip the fetch entirely — the endpoint 404s "Billing is not enabled" and
  // that raw error has no business reaching the UI — and render a friendly
  // "not available" state instead.
  const { data, isLoading, error, refetch } = useTransactions(limit, offset, typeFilter, {
    enabled: billingActive,
  });

  if (!billingActive) {
    return (
      <div className="border-border text-muted-foreground flex flex-col items-center gap-2 rounded-md border border-dashed px-4 py-10 text-center text-sm">
        <Coins className="text-muted-foreground/50 size-5" />
        <p>Credits and billing are not available on this instance.</p>
      </div>
    );
  }

  const handlePrevPage = () => {
    setOffset(Math.max(0, offset - limit));
  };

  const handleNextPage = () => {
    if (data?.pagination.has_more) {
      setOffset(offset + limit);
    }
  };

  if (isLoading && offset === 0) {
    return (
      <div className="space-y-2">
        {[...Array(5)].map((_, i) => (
          <Skeleton key={i} className="h-12 w-full rounded-md" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <InfoBanner tone="destructive" title="Failed to load transactions">
        {error.message || 'Failed to load transactions'}
      </InfoBanner>
    );
  }

  const transactions = data?.transactions || [];

  return (
    <div className="space-y-4">
      {/* Filter */}
      <div className="flex items-center gap-2">
        <Select
          value={typeFilter ?? 'all'}
          onValueChange={(v) => {
            setTypeFilter(v === 'all' ? undefined : v);
            setOffset(0);
          }}
        >
          <SelectTrigger className="h-9 w-[160px]">
            <SelectValue
              placeholder={tHardcodedUi.raw(
                'componentsBillingCreditTransactions.line159JsxAttrPlaceholderAllTypes',
              )}
            />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">
              {tHardcodedUi.raw('componentsBillingCreditTransactions.line162JsxTextAllTypes')}
            </SelectItem>
            <SelectItem value="tier_grant">
              {tHardcodedUi.raw('componentsBillingCreditTransactions.line163JsxTextTierGrant')}
            </SelectItem>
            <SelectItem value="purchase">Purchase</SelectItem>
            <SelectItem value="auto_topup">
              {tHardcodedUi.raw('componentsBillingCreditTransactions.line165JsxTextAutoTopUp')}
            </SelectItem>
            <SelectItem value="machine_bonus">
              {tHardcodedUi.raw('componentsBillingCreditTransactions.line166JsxTextMachineBonus')}
            </SelectItem>
            <SelectItem value="daily_refresh">
              {tHardcodedUi.raw('componentsBillingCreditTransactions.line167JsxTextDailyRefresh')}
            </SelectItem>
            <SelectItem value="admin_grant">
              {tHardcodedUi.raw('componentsBillingCreditTransactions.line168JsxTextAdminGrant')}
            </SelectItem>
            <SelectItem value="usage">Usage</SelectItem>
            <SelectItem value="refund">Refund</SelectItem>
            <SelectItem value="expired">Expired</SelectItem>
            <SelectItem value="adjustment">Adjustment</SelectItem>
            <SelectItem value="promotional">Promotional</SelectItem>
          </SelectContent>
        </Select>
        <Button variant="ghost" size="icon" aria-label="Refresh" onClick={() => refetch()}>
          <RefreshCw className="size-4" />
        </Button>
      </div>

      {transactions.length === 0 ? (
        <p className="text-muted-foreground px-3 py-8 text-center text-sm">
          {typeFilter ? `No ${typeFilter} transactions found.` : 'No transactions found.'}
        </p>
      ) : (
        <>
          <CreditTransactionsTable
            rows={transactions.map((tx) => ({
              id: tx.id,
              createdAt: tx.created_at,
              type: tx.type,
              description: tx.description ?? null,
              isExpiring: tx.is_expiring,
              amount: tx.amount,
              balanceAfter: tx.balance_after,
            }))}
          />
          {data?.pagination && (
            <div className="flex items-center justify-between">
              <p className="text-muted-foreground text-xs tabular-nums">
                Showing {offset + 1}-{Math.min(offset + limit, data.pagination.total)} of{' '}
                {data.pagination.total} transactions
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handlePrevPage}
                  disabled={offset === 0}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleNextPage}
                  disabled={!data.pagination.has_more}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

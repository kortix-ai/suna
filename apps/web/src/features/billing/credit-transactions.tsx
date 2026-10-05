'use client';

import { useTranslations } from '@/i18n/use-translations';

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
        <p>{tHardcodedUi.raw('i18nComplete.texte95b29e0f9c7')}</p>
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
      <InfoBanner tone="destructive" title={tHardcodedUi.raw('i18nComplete.textd7982e9989d5')}>
        {error.message || tHardcodedUi.raw('i18nComplete.textd7982e9989d5')}
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
            <SelectItem value="purchase">
              {tHardcodedUi.raw('i18nComplete.text5b5e9c65b400')}
            </SelectItem>
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
            <SelectItem value="usage">
              {tHardcodedUi.raw('i18nComplete.text8d59829c1e15')}
            </SelectItem>
            <SelectItem value="refund">
              {tHardcodedUi.raw('i18nComplete.text6b37bd35081f')}
            </SelectItem>
            <SelectItem value="expired">
              {tHardcodedUi.raw('i18nComplete.text424a2551d356')}
            </SelectItem>
            <SelectItem value="adjustment">
              {tHardcodedUi.raw('i18nComplete.textc416069b7f61')}
            </SelectItem>
            <SelectItem value="promotional">
              {tHardcodedUi.raw('i18nComplete.texta9b8859fba62')}
            </SelectItem>
          </SelectContent>
        </Select>
        <Button
          variant="ghost"
          size="icon"
          aria-label={tHardcodedUi.raw('i18nComplete.text0e9161011702')}
          onClick={() => refetch()}
        >
          <RefreshCw className="size-4" />
        </Button>
      </div>

      {transactions.length === 0 ? (
        <p className="text-muted-foreground px-3 py-8 text-center text-sm">
          {typeFilter
            ? tHardcodedUi('i18nComplete.texta2f7df9323a1', { value0: typeFilter })
            : tHardcodedUi.raw('i18nComplete.text7f85693ab42b')}
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
                {tHardcodedUi.raw('i18nComplete.textd604310a789a')} {offset + 1}-
                {Math.min(offset + limit, data.pagination.total)}{' '}
                {tHardcodedUi.raw('i18nComplete.text28391d3bc64e')} {data.pagination.total}{' '}
                {tHardcodedUi.raw('i18nComplete.text81dc075c3d55')}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handlePrevPage}
                  disabled={offset === 0}
                >
                  {tHardcodedUi.raw('i18nComplete.texta57b08a480b8')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleNextPage}
                  disabled={!data.pagination.has_more}
                >
                  {tHardcodedUi.raw('i18nComplete.text1ff57a29d7c9')}
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

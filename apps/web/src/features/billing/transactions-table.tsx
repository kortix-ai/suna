'use client';

/**
 * The credit ledger table — one implementation, two callers.
 *
 * Account settings (Billing → Credit ledger) renders it from
 * `GET /billing/transactions`; the admin account sheet renders it from
 * `GET /admin/api/accounts/{id}/ledger`. Both are the same `credit_ledger`
 * rows, so they get the same table: an operator looking at a support ticket
 * sees exactly what the customer sees, in the same order, with the same labels.
 *
 * Presentational ONLY — it fetches nothing and owns no filter state. The
 * caller supplies rows (see {@link CreditTransactionRow}); the admin adapter
 * lives in `app/admin/accounts/ledger-rows.ts`.
 */

import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { formatCredits, formatCreditsWithSign } from '@kortix/shared';
import { useTranslations } from 'next-intl';

/** One `credit_ledger` row, normalized across the two endpoints. */
export interface CreditTransactionRow {
  id: string;
  /** ISO-8601, or null when the source has no timestamp. */
  createdAt: string | null;
  /** Raw ledger type, e.g. `admin_grant`. Labelled by {@link creditTransactionBadge}. */
  type: string;
  description: string | null;
  /** Absent = the source does not say, and the Credit type cell stays empty. */
  isExpiring?: boolean;
  amount: number;
  balanceAfter: number;
}

type BadgeVariant = React.ComponentProps<typeof Badge>['variant'];

const TRANSACTION_BADGES: Record<string, { label: string; variant: BadgeVariant }> = {
  tier_grant: { label: 'Tier Grant', variant: 'default' },
  free_tier_grant: { label: 'Tier Grant', variant: 'secondary' },
  purchase: { label: 'Purchase', variant: 'default' },
  auto_topup: { label: 'Auto Top-up', variant: 'default' },
  machine_bonus: { label: 'Machine Bonus', variant: 'secondary' },
  admin_grant: { label: 'Admin Grant', variant: 'secondary' },
  promotional: { label: 'Promotional', variant: 'secondary' },
  daily_refresh: { label: 'Daily Refresh', variant: 'secondary' },
  usage: { label: 'Usage', variant: 'outline' },
  llm_debit: { label: 'LLM', variant: 'outline' },
  token_deduction: { label: 'LLM', variant: 'outline' },
  token_overage: { label: 'LLM Overage', variant: 'outline' },
  compute_debit: { label: 'Sandbox', variant: 'outline' },
  compute_refund: { label: 'Sandbox Refund', variant: 'secondary' },
  refund: { label: 'Refund', variant: 'secondary' },
  adjustment: { label: 'Adjustment', variant: 'outline' },
  expired: { label: 'Expired', variant: 'destructive' },
};

/**
 * Label and badge variant for a ledger type. An unknown type renders as its own
 * key — new types ship from the API before the UI learns them, and a raw key
 * beats a blank cell.
 */
export function creditTransactionBadge(type: string): { label: string; variant: BadgeVariant } {
  return TRANSACTION_BADGES[type] ?? { label: type, variant: 'outline' };
}

// Hoisted so render does not rebuild the formatter per row — same fixed
// locale and options as the previous inline `toLocaleString` call.
const TRANSACTION_DATE_FORMAT = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

function formatDate(value: string | null): string {
  if (!value) return '—';
  return TRANSACTION_DATE_FORMAT.format(new Date(value));
}

export function CreditTransactionsTable({ rows }: { rows: CreditTransactionRow[] }) {
  // Two headers are translated (the rest of this table was never localized).
  // Keeping the same keys keeps the customer surface byte-identical in all
  // eight locales; the admin console renders under the same I18nProvider.
  const tHardcodedUi = useTranslations('hardcodedUi');

  // `Table` already renders the `bg-popover rounded-md border` surface, so
  // there is no second bordered box around it — that was a doubled 1px ring at
  // the same radius, and nested rounding is what the design system forbids.
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[180px]">Date</TableHead>
          <TableHead>Type</TableHead>
          <TableHead>Description</TableHead>
          <TableHead className="text-center">
            {tHardcodedUi.raw('componentsBillingCreditTransactions.line198JsxTextCreditType')}
          </TableHead>
          <TableHead className="text-right">Credits</TableHead>
          <TableHead className="text-right">
            {tHardcodedUi.raw('componentsBillingCreditTransactions.line200JsxTextCreditsAfter')}
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const badge = creditTransactionBadge(row.type);
          return (
            <TableRow key={row.id}>
              <TableCell className="font-mono text-xs">{formatDate(row.createdAt)}</TableCell>
              <TableCell>
                <Badge variant={badge.variant} size="sm">
                  {badge.label}
                </Badge>
              </TableCell>
              <TableCell className="text-sm">{row.description || 'No description'}</TableCell>
              <TableCell className="text-center">
                {row.isExpiring !== undefined && (
                  <span className="text-muted-foreground text-xs">
                    {row.isExpiring ? 'Expiring' : 'Permanent'}
                  </span>
                )}
              </TableCell>
              <TableCell
                className={cn(
                  'text-right font-mono font-medium tabular-nums',
                  row.amount >= 0 ? 'text-kortix-green' : 'text-kortix-red',
                )}
              >
                {formatCreditsWithSign(row.amount, { showDecimals: true })}
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums">
                {formatCredits(row.balanceAfter, { showDecimals: true })}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

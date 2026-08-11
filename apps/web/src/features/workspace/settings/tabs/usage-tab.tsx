'use client';

/**
 * The Usage tab — the cost explorer's Project -> Sessions -> Session
 * drill-down, stacked above the credit ledger. Both answer "where did the
 * money go"; the chart is the faster answer, so it goes first (this task's
 * brief). Sourced from `features/billing/cost-explorer/cost-explorer.tsx`
 * (`CostExplorer`) and `features/accounts/settings/transactions-tab.tsx`
 * (`TransactionsTab`) — see this task's report for the full numbered
 * enumeration of every control/query/mutation in both and where each landed
 * here. Neither source file is modified: `/accounts/[id]` is still live and
 * this task must not touch anything under `app/(app)/accounts/**`.
 *
 * **Layout change from the source, called out explicitly.** `TransactionsTab`
 * put Session costs and Credit ledger behind two `TabsTrigger`s ("Session
 * costs" / "Credit ledger" — `features/accounts/settings/
 * transactions-tab.tsx:11-12`) — only one was ever visible at once. This
 * task's brief asks for both stacked in one scroll, cost explorer first, so
 * that switch is gone; nothing else about either surface changed. The two
 * section headings below are newly authored for this stacked layout, reusing
 * the wording of those two trigger labels since it already names the two
 * questions this tab answers.
 *
 * **Gating — matches `transactions`, not `billing`.** The account page's
 * `sectionVisible` map (`app/(app)/accounts/[id]/page.tsx:354-365`) gates
 * `transactions: canWriteAccount === true` — no `billingActive` in that
 * expression, unlike `billing: canWriteAccount === true && billingActive`
 * one line above it. `UsageTab` mirrors that exactly: the whole tab gates on
 * `account.write` alone (`canViewUsage` below), matching `billing`'s
 * `canWriteAccount` half but deliberately NOT adding an `isBillingEnabled()`
 * gate on top. The page's own comment explains why (`page.tsx:347-348`):
 * "Self-host billing-disabled: no Stripe plan controls to show. Session costs
 * remain available because they do not require the internal billing engine."
 * `CostExplorer` itself never calls `isBillingEnabled()` — confirmed by
 * `grep -n isBillingEnabled` over `features/billing/cost-explorer/**`
 * returning no hits — so it renders unconditionally once `canViewUsage` is
 * true, billing on or off. `CreditTransactions` (the credit-ledger slot)
 * DOES call `isBillingEnabled()` itself (`features/billing/
 * credit-transactions.tsx:40,51`) and renders its own "Credits and billing
 * are not available on this instance." empty state when it's off — that gate
 * lives inside the component this file reuses unmodified, so it is preserved
 * automatically, not re-implemented here.
 *
 * **No separate `billing.write`-style write gate.** Unlike Billing
 * (Task 11), this tab has no mutating control gated more tightly than
 * `account.write` — CSV export and pagination are the only "actions" here,
 * both read-only, and the old page gated the whole `transactions` section on
 * a single boolean. So `UsageTab` needs only one permission probe, not two.
 *
 * **Account id.** Same shape as `BillingTab` and `ConnectedAccountsTab`:
 * `useSettingsAccountId(accountId)` (`../use-settings-account-id.ts`), not
 * `project?.account_id` alone — see that file's header comment for why the
 * fallback exists (permission unresolvable with no project open otherwise).
 *
 * **`BillingAccountProvider` — same reason `BillingTab` nests its own.**
 * Every query and mutation this tab pulls in reads `useBillingAccountId()`
 * from `stores/billing-account-context` internally rather than taking an
 * explicit accountId prop: `useCostSummary`/`useCostByProject`/
 * `useSessionCostProjects`/`useSessionCostDetail`/`useSessionCosts`
 * (`hooks/billing/use-cost-explorer.ts:12`, `hooks/billing/
 * use-session-costs.ts:13`), `CostExportButton`
 * (`cost-explorer/cost-export-button.tsx:276`), and `useTransactions`
 * (`hooks/billing/use-transactions.ts:3,52,91`, which is what
 * `CreditTransactions` calls — its own `accountId` prop is declared but never
 * read in its body, confirmed by `grep -n accountId
 * features/billing/credit-transactions.tsx` returning only the prop
 * declaration and the destructure). `UsageTab` therefore nests its own
 * `BillingAccountProvider` seeded with THIS tab's `resolvedAccountId`, so
 * every one of those reads agrees with this tab's own permission probe by
 * construction, exactly as `billing-tab.tsx`'s header comment documents for
 * the same reason.
 *
 * `UsageTabView` is the pure, props-only half — no hooks, no data fetching,
 * no router. `CostExplorer` reads `useRouter`/`usePathname`/`useSearchParams`
 * (its URL-addressable drill-down state) and every query above needs a
 * `QueryClientProvider`; `CreditTransactions` needs both a `QueryClientProvider`
 * and `next-intl`'s `useTranslations`. None of that exists under
 * `renderToStaticMarkup`, so both are threaded through as optional `ReactNode`
 * slots, left `undefined` by default — the same pattern `billing-tab.tsx`
 * uses for its own hook-driven children.
 *
 * **Untestable here, by design (see the task brief's constraints):** the
 * actual CSV export network round trip, the drill-down navigation (URL
 * pushes on row/breadcrumb clicks), and the credit-ledger pagination all need
 * a live network, a real router, and a real DOM. `bun test` has no DOM. The
 * tests in `usage-tab.test.tsx` cover what the pure view can prove
 * statically: section order (cost explorer above credit ledger) and slot
 * presence — they do not, and cannot, click a row or observe a network call.
 */

import type { ReactNode } from 'react';

import { SettingsSectionHeader } from '@/components/ui/settings-section-header';
import { CostExplorer } from '@/features/billing/cost-explorer/cost-explorer';
import CreditTransactions from '@/features/billing/credit-transactions';
import { usePermission } from '@/lib/use-permission';
import { BillingAccountProvider } from '@/stores/billing-account-context';

import { SettingsTabHeader } from '../settings-tab-header';
import { useSettingsAccountId } from '../use-settings-account-id';

export interface UsageTabViewProps {
  /** The Project -> Sessions -> Session cost drill-down — `CostExplorer`,
   *  unmodified. Rendered first (see this file's header comment). */
  sessionCostsSlot?: ReactNode;
  /** The account's credit transaction history — `CreditTransactions`,
   *  unmodified. Self-gates on `isBillingEnabled()` internally. */
  creditLedgerSlot?: ReactNode;
}

/** Presentational only — no hooks, no data fetching, no store or Supabase
 *  read. Kept separate from `UsageTab` so this renders under
 *  `renderToStaticMarkup` with no `QueryClientProvider` or router — see
 *  `BillingTabView` for the same split. */
export function UsageTabView({ sessionCostsSlot, creditLedgerSlot }: UsageTabViewProps) {
  return (
    <div className="mx-auto w-full max-w-4xl space-y-8 px-6 py-10">
      <SettingsTabHeader tab="usage" />
      <section className="space-y-4">
        <SettingsSectionHeader
          title="Session costs"
          description="Where LLM and compute spend went, by project and session."
        />
        {sessionCostsSlot}
      </section>

      <section className="space-y-4">
        <SettingsSectionHeader
          title="Credit ledger"
          description="Every credit grant, purchase, and debit on this account."
        />
        {creditLedgerSlot}
      </section>
    </div>
  );
}

/** Container entry point. Resolves the account id once, then nests a
 *  `BillingAccountProvider` seeded with it — see this file's header comment
 *  — so every `useBillingAccountId()` read inside `CostExplorer` and
 *  `CreditTransactions` agrees with this tab's own `account.write` probe. */
export function UsageTab({ accountId }: { accountId?: string }) {
  const resolvedAccountId = useSettingsAccountId(accountId);
  return (
    <BillingAccountProvider accountId={resolvedAccountId ?? null} resolved>
      <UsageTabInner accountId={resolvedAccountId} />
    </BillingAccountProvider>
  );
}

/** Owns the one permission probe. Only ever mounted while this tab is
 *  active (`SettingsTabPane` in `settings-panel.tsx` returns `null`
 *  otherwise), so nothing here fetches on panel open. */
function UsageTabInner({ accountId: resolvedAccountId }: { accountId: string | undefined }) {
  // Whole-tab visibility — account.write, matching the source page's
  // `sectionVisible.transactions` gate exactly (see this file's header
  // comment). Deliberately NOT combined with `isBillingEnabled()` — session
  // costs stay available with billing off; only the ledger sub-section
  // self-gates on that, inside `CreditTransactions`.
  const { allowed: canViewUsage } = usePermission(resolvedAccountId, 'account.write');

  if (!canViewUsage) return null;

  return (
    <UsageTabView
      sessionCostsSlot={<CostExplorer />}
      creditLedgerSlot={<CreditTransactions accountId={resolvedAccountId} />}
    />
  );
}

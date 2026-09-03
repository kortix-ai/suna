'use client';

/**
 * The Plan tab — the account's subscription, credits, and billing portal.
 *
 * Added 2026-09-02 (Jay: "there should be a section for the plan that shows
 * the subscription and the current plan"). It is a second door onto the SAME
 * component `/accounts/[id]?tab=billing` renders — `BillingTab` in
 * `features/accounts/settings/billing-tab.tsx` — mounted with the same
 * provider and the same gate. One component, two mounts; the only difference
 * is `showWallet`, which chooses which of the two blocks leads (see the JSX
 * below and `BillingTab`'s own doc comment). No billing LOGIC is forked:
 *
 * - `BillingAccountProvider` scopes every billing hook below to THIS account,
 *   so a multi-account user never reads or mutates their primary account by
 *   accident.
 * - `GlobalUpgradeModal` is mounted beside it because the "Subscribe" button
 *   opens the global upgrade-dialog store, and the global renderer lives only
 *   on share pages.
 * - The gate is `account.write`, exactly as the account page gates its Billing
 *   tab. A member without it sees who to ask instead of a pane of buttons that
 *   would each fail.
 *
 * The Stripe portal's `return_url` must be absolute; `/settings/plan` is the
 * route that reopens this overlay on this very tab, so a person who leaves for
 * the portal lands back here.
 */

import { Button } from '@/components/ui/button';
import { SettingsRow, SettingsRowGroup } from '@/components/ui/settings-row';
import { Skeleton } from '@/components/ui/skeleton';
import { BillingTab } from '@/features/accounts/settings/billing-tab';
import { GlobalUpgradeModal } from '@/features/billing/global-upgrade-modal';
import { usePermission } from '@/lib/use-permission';
import { BillingAccountProvider } from '@/stores/billing-account-context';
import Link from 'next/link';
import { SettingsTabHeader } from '../settings-tab-header';

function planReturnUrl(): string {
  return typeof window !== 'undefined'
    ? `${window.location.origin}/settings/plan`
    : '/settings/plan';
}

export function PlanTab({ accountId }: { accountId: string | undefined }) {
  const canWrite = usePermission(accountId, 'account.write');

  return (
    <div className="mx-auto w-full max-w-2xl space-y-8">
      <SettingsTabHeader tab="plan" />

      {!accountId || canWrite.isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-32 w-full rounded-md" />
          <Skeleton className="h-32 w-full rounded-md" />
        </div>
      ) : canWrite.allowed ? (
        <BillingAccountProvider accountId={accountId}>
          {/* `showWallet={false}` (Jay, 2026-09-03: "in the plan, you need to
              show just the team part, team seat"). The pane leads with
              `PlanCard` — the subscription, with the seat count, price each
              and monthly total as properties under it — instead of the
              wallet-first `AccountOverviewTab`. Balance, credit composition,
              period spend and limits are the Credits pane's subject now
              (`tabs/credits-tab.tsx`), one row above this one in the rail.
              `/accounts/[id]?tab=billing` passes nothing and keeps the
              wallet-first layout unchanged. */}
          <BillingTab returnUrl={planReturnUrl()} isActive showWallet={false} />
          <GlobalUpgradeModal />
        </BillingAccountProvider>
      ) : (
        <SettingsRowGroup>
          <SettingsRow
            label="Managed by an account admin"
            description="Only admins of this account can change its plan or buy credits."
          >
            <Button asChild variant="secondary" size="sm">
              <Link href={`/accounts/${accountId}`}>Open account</Link>
            </Button>
          </SettingsRow>
        </SettingsRowGroup>
      )}
    </div>
  );
}

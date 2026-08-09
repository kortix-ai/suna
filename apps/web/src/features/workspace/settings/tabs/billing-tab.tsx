'use client';

/**
 * The Billing tab — plan/wallet/spend, per-seat claim/manage, auto top-up,
 * one-time credit top-up, and the Stripe billing portal. Ported from
 * `features/accounts/settings/billing-tab.tsx` (the `/accounts/[id]` page's
 * Billing pane) — see this task's report for the full numbered enumeration
 * of that file's controls/queries/mutations and where each landed here.
 * That source file is untouched: `/accounts/[id]` is still live and this task
 * must not modify anything under `app/(app)/accounts/**`.
 *
 * **New gate, not in the source file.** This tab renders nothing at all
 * unless the current user holds `billing.write` on the resolved account AND
 * `isBillingEnabled()` — a self-hosted build with billing off must not show
 * a Stripe control that would 404/error on click. The source file had no
 * `billing.write` probe (the `/accounts/[id]` page already gated the whole
 * pane on `canWriteAccount` one level up) and only gated the one Billing-
 * portal *section* on `isBillingEnabled()`; the settings panel has no
 * equivalent outer gate, so this tab owns both checks itself, at the whole-
 * tab level. Both checks are read after every hook below (see the plain
 * `if` near the bottom of `BillingTab`) — never inside a conditional
 * upstream of a hook call, so the hook count never changes render to render.
 *
 * **Account id.** The source file read `useBillingAccountId()` (the
 * `BillingAccountProvider` context `/accounts/[id]` wraps itself with, fed
 * by the route's own `account.account_id`) for the top-level query, the
 * `billing.write` probe, and `openUpgradeDialog`. This tab instead resolves
 * its account id with `useSettingsAccountId(accountId)` (see
 * `../use-settings-account-id.ts`) for those same three uses — the project's
 * account wins when a project is open, falling back to the app-wide selected
 * account so the permission probe still resolves with no project open (the
 * same fix `connected-tab.tsx` needed — see that file's header comment).
 * `AutoTopupCard`, `CreditTopupSection`, and `useCreatePortalSession` are
 * reused as-is and keep reading `useBillingAccountId()` internally — that
 * context is already provided around the whole settings panel by
 * `project-shell.tsx`'s `BillingAccountProvider`, and touching those three
 * shared hooks to accept an explicit accountId is out of this task's scope
 * (same "do not re-litigate `useBillingAccountId()`" boundary the shared
 * hook's own header comment documents).
 *
 * **`isActive` dropped, not lost.** The source component took `returnUrl`
 * and `isActive` props and invalidated the account-state query on `isActive`
 * transitioning false→true, because it lived inside a surface that stayed
 * mounted (CSS-hidden) across tab switches. `SettingsTabPane` in
 * `settings-panel.tsx` unmounts every inactive tab's real view instead, so
 * `BillingTab` only ever mounts while it is the active tab — "on mount"
 * already means "on becoming active" here. `returnUrl` (an absolute URL,
 * required by the Stripe portal API) is now built from `window.location.href`
 * instead of threaded in as a prop, since the deep-link path itself no
 * longer needs to be known by a caller.
 *
 * `BillingTabView` is the pure, props-only half — no hooks, no data
 * fetching. `AccountOverviewTab`, `ClaimPerSeatCard`, `SeatManagementCard`,
 * `AutoTopupCard`, and `CreditTopupSection` all own their own React Query
 * reads/mutations internally, so they can't render under
 * `renderToStaticMarkup` (no `QueryClientProvider` there) — they're threaded
 * through as optional `ReactNode` slots instead, left `undefined` by default,
 * the same pattern `connected-tab.tsx` uses for `chatgptConnectSlot` (see
 * that file's header comment). `BillingTab` is the container: every hook
 * only runs once this tab actually mounts, which `SettingsTabPane` guarantees
 * happens only while this tab is the active one.
 *
 * **Untestable here, by design (see the task brief's constraints):** the
 * actual Stripe Checkout/portal redirects, the credit-purchase and
 * auto-top-up round trips, and the per-seat claim mutation all require a
 * live network + a real browser round trip. `bun test` has no DOM and no
 * live API — the tests in `billing-tab.test.tsx` cover everything the pure
 * view can prove statically: section order (Plan/wallet/spend before the
 * rest), the team-checkout branch replacing the main branch entirely, the
 * credits-ran-out banner, the `canPurchaseCredits` and `billingEnabled`
 * gates, and slot presence — they do not, and cannot, click a button and
 * observe a network call.
 */

import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
import Loading from '@/components/ui/loading';
import { SettingsSectionHeader } from '@/components/ui/settings-section-header';
import { Skeleton } from '@/components/ui/skeleton';
import { AccountOverviewTab } from '@/features/billing/account-overview';
import { AutoTopupCard } from '@/features/billing/auto-topup-card';
import { ClaimPerSeatCard } from '@/features/billing/claim-per-seat-card';
import { CreditTopupSection } from '@/features/billing/credit-topup-section';
import { SeatManagementCard } from '@/features/billing/seat-management-card';
import { useAuth } from '@/features/providers/auth-provider';
import {
  accountStateKeys,
  accountStateSelectors,
  invalidateAccountState,
  useCreatePortalSession,
} from '@/hooks/billing';
import { isBillingEnabled } from '@/lib/config';
import { usePermission } from '@/lib/use-permission';
import { useUpgradeDialogStore } from '@/stores/upgrade-dialog-store';
import { useUserSettingsModalStore } from '@/stores/user-settings-modal-store';
import { getAccountState, type AccountState } from '@kortix/sdk';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { useSettingsAccountId } from '../use-settings-account-id';

export interface BillingTabViewProps {
  /** Account-state query still in flight (or auth still resolving). */
  isLoading?: boolean;
  /** Account-state query error message, or `null`. */
  error?: string | null;

  /** Shown INSTEAD of the whole main branch below when true — no active
   *  subscription yet, on a deployment with billing turned on. */
  showTeamCheckout?: boolean;
  onSubscribeTeam?: () => void;
  onManageSubscription?: () => void;
  isManagingSubscription?: boolean;

  /** The "you ran out of credits" banner, shown above Plan/wallet/spend. */
  showCreditsRanOutBanner?: boolean;
  /** Gates the Auto top-up and Buy credits sections, and changes the
   *  credits-ran-out banner's body copy. */
  canPurchaseCredits?: boolean;

  /** Whether Stripe billing (subscriptions, the portal) is turned on for
   *  this deployment. Gates the Billing portal section on its own, in
   *  addition to the whole-tab gate `BillingTab` applies below — belt and
   *  suspenders, so a self-hosted build with billing off never renders a
   *  broken Stripe control even if the outer gate is ever bypassed by a
   *  future refactor (`settings-panel.tsx`'s header comment documents the
   *  same "gate explicitly in our own code" philosophy). */
  billingEnabled?: boolean;

  // Slots for the hook-driven child widgets — each owns its own React Query
  // reads/mutations internally, so they can't render under
  // `renderToStaticMarkup` (no `QueryClientProvider` there). Left
  // `undefined` by default so the bare view renders each section's chrome
  // with no data. See this file's header comment.
  accountOverviewSlot?: ReactNode;
  claimPerSeatSlot?: ReactNode;
  seatManagementSlot?: ReactNode;
  autoTopupSlot?: ReactNode;
  creditTopupSlot?: ReactNode;
}

/** Presentational only — no hooks, no data fetching, no store or Supabase
 *  read. Kept separate from `BillingTab` so this renders under
 *  `renderToStaticMarkup` without a `QueryClientProvider` or a Supabase
 *  session — see `ProfileTabView` / `ConnectedAccountsTabView` for the same
 *  split. Every prop is optional with a safe default. */
export function BillingTabView({
  isLoading = false,
  error = null,
  showTeamCheckout = false,
  onSubscribeTeam = () => {},
  onManageSubscription = () => {},
  isManagingSubscription = false,
  showCreditsRanOutBanner = false,
  canPurchaseCredits = false,
  billingEnabled = true,
  accountOverviewSlot,
  claimPerSeatSlot,
  seatManagementSlot,
  autoTopupSlot,
  creditTopupSlot,
}: BillingTabViewProps) {
  if (isLoading) {
    return (
      <div className="mx-auto w-full max-w-lg space-y-4 px-6 py-10">
        <Skeleton className="h-32 w-full rounded-md" />
        <Skeleton className="h-32 w-full rounded-md" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto w-full max-w-lg px-6 py-10">
        <InfoBanner tone="destructive">{error}</InfoBanner>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-lg space-y-8 px-6 py-10">
      {showTeamCheckout ? (
        <section className="space-y-4">
          <SettingsSectionHeader
            title="Kortix Team"
            description="Subscribe to put your whole team on Kortix — LLM compute and AI Computers, one wallet."
          />
          <div className="bg-popover rounded-md border px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Button type="button" size="sm" onClick={onSubscribeTeam} className="shrink-0">
                Subscribe to Team
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-foreground gap-1.5"
                onClick={onManageSubscription}
                disabled={isManagingSubscription}
              >
                {isManagingSubscription ? <Loading className="size-4 shrink-0" /> : null}
                Manage billing
              </Button>
            </div>
          </div>
        </section>
      ) : (
        <>
          {/* 1. Plan, wallet, and spend — always first (see the task brief). */}
          {showCreditsRanOutBanner && (
            <InfoBanner tone="warning" title="You ran out of credits">
              {canPurchaseCredits
                ? 'Buy credits below or turn on auto top-up so it never happens again.'
                : 'Top up your wallet to keep your agents running.'}
            </InfoBanner>
          )}

          <section className="space-y-4">
            <SettingsSectionHeader title="Plan, wallet and spend" />
            {accountOverviewSlot}
          </section>

          {/* 2. Per-seat claim / seat management — each card self-guards on
              whether it applies, same as the source file. */}
          {claimPerSeatSlot}
          {seatManagementSlot}

          {/* 3. Auto top-up. */}
          {canPurchaseCredits && (
            <section className="space-y-4">
              <SettingsSectionHeader title="Auto top-up" description="Never run out again" />
              <div className="bg-popover rounded-md border px-4 py-3">{autoTopupSlot}</div>
            </section>
          )}

          {/* 4. Buy credits. */}
          {canPurchaseCredits && (
            <section className="space-y-4">
              <SettingsSectionHeader title="Buy credits" description="One-time top-up" />
              <div className="bg-popover rounded-md border px-4 py-3">{creditTopupSlot}</div>
            </section>
          )}

          {/* 5. Billing portal — the Stripe billing portal doesn't exist
              without billing enabled (self-host with billing off); hide the
              whole section rather than let it 404/error on click. */}
          {billingEnabled ? (
            <section className="space-y-4">
              <SettingsSectionHeader
                title="Billing portal"
                description="Manage your subscription, payment methods, and invoices."
                action={
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="shrink-0 gap-1.5"
                    onClick={onManageSubscription}
                    disabled={isManagingSubscription}
                  >
                    {isManagingSubscription ? <Loading className="size-4 shrink-0" /> : null}
                    Manage billing
                  </Button>
                }
              />
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}

/** Container: owns every hook (React Query, permission probe, auth) and
 *  renders `BillingTabView` with real data + handlers. Only ever mounted
 *  while this tab is active (`SettingsTabPane` in `settings-panel.tsx`
 *  returns `null` otherwise), so nothing here fetches on panel open. */
export function BillingTab({ accountId }: { accountId?: string }) {
  const resolvedAccountId = useSettingsAccountId(accountId);
  const { allowed: canManageBilling } = usePermission(resolvedAccountId, 'billing.write');
  const billingEnabled = isBillingEnabled();

  const { session, isLoading: authLoading } = useAuth();
  const highlight = useUserSettingsModalStore((s) => s.highlight);
  const openUpgradeDialog = useUpgradeDialogStore((s) => s.openUpgradeDialog);
  const queryClient = useQueryClient();

  const {
    data: accountState,
    isLoading: isLoadingSubscription,
    error: subscriptionError,
  } = useQuery<AccountState>({
    queryKey: accountStateKeys.state(resolvedAccountId),
    queryFn: () => getAccountState({ accountId: resolvedAccountId }),
    enabled: billingEnabled && canManageBilling && !!session && !authLoading,
    staleTime: 1000 * 60 * 2,
    gcTime: 1000 * 60 * 15,
    refetchOnWindowFocus: false,
    refetchOnMount: true,
    refetchInterval: (query) => {
      const data = query.state.data as AccountState | undefined;
      const hasProvisioning = data?.instances?.some(
        (i: { status: string }) => i.status === 'provisioning',
      );
      return hasProvisioning ? 5000 : false;
    },
    refetchIntervalInBackground: false,
  });

  const createPortalSessionMutation = useCreatePortalSession();
  const totalCredits = accountStateSelectors.totalCredits(accountState);

  // See this file's header comment ("`isActive` dropped, not lost") — this
  // tab only ever mounts while active, so a mount-once effect reproduces the
  // source file's "invalidate on becoming active" behaviour with no
  // `isActive` prop needed.
  const hasInvalidatedOnMount = useRef(false);
  useEffect(() => {
    if (!hasInvalidatedOnMount.current && session && !authLoading) {
      hasInvalidatedOnMount.current = true;
      invalidateAccountState(queryClient, true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, authLoading]);

  const handleManageSubscription = () => {
    const returnUrl = typeof window !== 'undefined' ? window.location.href : '';
    createPortalSessionMutation.mutate({ return_url: returnUrl });
  };

  const isLoading = isLoadingSubscription || authLoading;
  const error = subscriptionError
    ? subscriptionError instanceof Error
      ? subscriptionError.message
      : 'Failed to load subscription data'
    : null;

  const subscription = accountState?.subscription;
  const canPurchaseCredits = subscription?.can_purchase_credits || false;
  const isPerSeat = accountState?.billing_model === 'per_seat';
  const hasActiveSubscription = Boolean(subscription?.subscription_id);
  const subscribedToTeam = isPerSeat && hasActiveSubscription;
  const showTeamCheckout = billingEnabled && !hasActiveSubscription;

  // The whole-tab gate — see this file's header comment. Placed after every
  // hook above so the hook count never changes render to render.
  if (!billingEnabled || !canManageBilling) return null;

  return (
    <BillingTabView
      isLoading={isLoading}
      error={error}
      showTeamCheckout={showTeamCheckout}
      onSubscribeTeam={() =>
        openUpgradeDialog({ reason: 'subscription_required', accountId: resolvedAccountId })
      }
      onManageSubscription={handleManageSubscription}
      isManagingSubscription={createPortalSessionMutation.isPending}
      showCreditsRanOutBanner={highlight === 'credits' && totalCredits <= 0}
      canPurchaseCredits={canPurchaseCredits}
      billingEnabled={billingEnabled}
      accountOverviewSlot={<AccountOverviewTab accountId={resolvedAccountId} />}
      claimPerSeatSlot={
        accountState?.can_claim_per_seat ? (
          <ClaimPerSeatCard accountState={accountState} />
        ) : undefined
      }
      seatManagementSlot={
        subscribedToTeam && accountState ? (
          <SeatManagementCard accountState={accountState} />
        ) : undefined
      }
      autoTopupSlot={canPurchaseCredits ? <AutoTopupCard fetchSettings showSaveButton /> : undefined}
      creditTopupSlot={canPurchaseCredits ? <CreditTopupSection /> : undefined}
    />
  );
}

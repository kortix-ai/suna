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
 * **Read vs. write gate — fix round 1.** The first version of this file
 * gated the WHOLE tab on `billing.write`, which is `OWNER_ONLY`
 * (`apps/api/src/iam/role-perms.ts`). The source page it was ported from
 * gated Billing visibility on `account.write` (`canWriteAccount` —
 * `app/(app)/accounts/[id]/page.tsx`), which admins hold too, and the
 * read-only plan/wallet/spend query (`GET /billing/account-state`) only ever
 * required plain membership server-side
 * (`apps/api/src/billing/routes/account-state.ts`) — no `billing.write` at
 * all. Gating the whole tab on `billing.write` therefore hid a view a
 * non-owner admin could always see before. Fixed by splitting the two:
 *
 * - **Whole-tab visibility** gates on `account.write` (`canViewBilling`
 *   below) AND `isBillingEnabled()` — matches the source page's
 *   `canWriteAccount` gate exactly. Admins and owners both see the tab;
 *   plain members see neither this tab nor the old page's Billing pane.
 * - **Mutating controls** — Subscribe to Team, the per-seat claim, auto
 *   top-up, buy credits, and the Stripe portal session — gate on
 *   `billing.write` (`canManageBilling` below), which the account-state
 *   response already carries as `can_manage_billing`
 *   (`apps/api/src/billing/routes/account-state.ts`'s `canManageBilling()` —
 *   the exact same server-side `billing.write` check
 *   `require-billing-write.ts` runs before any mutation, surfaced as a UI
 *   hint on the read query so the client never needs a second IAM
 *   round-trip). Read from `accountState?.can_manage_billing !== false`, the
 *   identical `!== false` (fail-open on `undefined`, matching the server's
 *   own "default true on probe error" comment) pattern
 *   `global-upgrade-modal.tsx` already uses for the same field. Since
 *   mutations are already rejected server-side without `billing.write`
 *   (`require-billing-write.ts`), hiding the controls client-side is a UX
 *   improvement (no button that 403s), not a new security boundary.
 *
 * **Account id.** The source file read `useBillingAccountId()` (the
 * `BillingAccountProvider` context `/accounts/[id]` wraps itself with, fed
 * by the route's own `account.account_id`) for the top-level query, the
 * (nonexistent) write probe, and `openUpgradeDialog`. This tab instead
 * resolves its account id with `useSettingsAccountId(accountId)` (see
 * `../use-settings-account-id.ts`) for those same uses — the project's
 * account wins when a project is open, falling back to the app-wide selected
 * account so the permission probe still resolves with no project open (the
 * same fix `connected-tab.tsx` needed — see that file's header comment).
 *
 * **`useBillingAccountId()` divergence — fix round 1, finding 2.**
 * `AutoTopupCard`, `CreditTopupSection`, and `useCreatePortalSession` each
 * read `useBillingAccountId()` internally rather than taking an explicit
 * accountId prop. That context's only other provider
 * (`project-shell.tsx`'s `BillingAccountProvider`, fed by
 * `projectDetail?.project?.account_id ?? null`, no store fallback) can
 * transiently disagree with `useSettingsAccountId`'s resolved value — e.g. a
 * multi-account user with a stale `selectedAccountId` opens a project before
 * `projectDetail` resolves: this tab's own query/permission read the store
 * fallback while those three widgets would read `undefined` (self-heals once
 * `projectDetail` resolves, but wrong in the meantime). Rather than adding an
 * explicit-accountId prop to three shared billing hooks (touches call sites
 * outside this tab, out of scope), `BillingTab` now nests its own
 * `BillingAccountProvider` — exported and side-effect-free to nest, per its
 * own header comment — around everything below it, seeded with THIS tab's
 * `resolvedAccountId`. React context resolves to the *nearest* provider, so
 * every `useBillingAccountId()` read inside this tab's subtree (the three
 * widgets above, plus `useCreatePortalSession`) now agrees with this tab's
 * own query/permission by construction; nothing outside this tab's subtree
 * is affected, since the outer `project-shell.tsx` provider is merely
 * shadowed, not replaced. See `BillingTab` (the outer component, which nests
 * the provider) vs. `BillingTabInner` (everything that must resolve
 * `useBillingAccountId()` to the SAME value as `resolvedAccountId`) below.
 *
 * **`isActive` dropped, not lost.** The source component took `returnUrl`
 * and `isActive` props and invalidated the account-state query on `isActive`
 * transitioning false→true, because it lived inside a surface that stayed
 * mounted (CSS-hidden) across tab switches. `SettingsTabPane` in
 * `settings-panel.tsx` unmounts every inactive tab's real view instead, so
 * this tab only ever mounts while it is the active tab — "on mount" already
 * means "on becoming active" here. `returnUrl` (an absolute URL, required by
 * the Stripe portal API) is now built from `window.location.href` instead of
 * threaded in as a prop, since the deep-link path itself no longer needs to
 * be known by a caller.
 *
 * `BillingTabView` is the pure, props-only half — no hooks, no data
 * fetching. `AccountOverviewTab`, `ClaimPerSeatCard`, `SeatManagementCard`,
 * `AutoTopupCard`, and `CreditTopupSection` all own their own React Query
 * reads/mutations internally, so they can't render under
 * `renderToStaticMarkup` (no `QueryClientProvider` there) — they're threaded
 * through as optional `ReactNode` slots instead, left `undefined` by default,
 * the same pattern `connected-tab.tsx` uses for `chatgptConnectSlot` (see
 * that file's header comment). `BillingTab`/`BillingTabInner` are the
 * container: every hook only runs once this tab actually mounts, which
 * `SettingsTabPane` guarantees happens only while this tab is the active one.
 *
 * **Untestable here, by design (see the task brief's constraints):** the
 * actual Stripe Checkout/portal redirects, the credit-purchase and
 * auto-top-up round trips, and the per-seat claim mutation all require a
 * live network + a real browser round trip. `bun test` has no DOM and no
 * live API — the tests in `billing-tab.test.tsx` cover everything the pure
 * view can prove statically: section order (Plan/wallet/spend before the
 * rest), the team-checkout branch replacing the main branch entirely, the
 * credits-ran-out banner, the `canPurchaseCredits`/`billingEnabled` gates,
 * the `canManageBilling` read/write split, and slot presence — they do not,
 * and cannot, click a button and observe a network call.
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
import { BillingAccountProvider } from '@/stores/billing-account-context';
import { useUpgradeDialogStore } from '@/stores/upgrade-dialog-store';
import { useUserSettingsModalStore } from '@/stores/user-settings-modal-store';
import { getAccountState, type AccountState } from '@kortix/sdk';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { useSettingsAccountId } from '../use-settings-account-id';

/** Reused wherever a mutating control is hidden for a `billing.write`-less
 *  viewer — the exact copy `global-upgrade-modal.tsx`'s team-plan checkout
 *  already ships for the same "you can see this, only an owner can act on
 *  it" state (`autoFeaturesBillingTeamPlanCheckoutJsxAttrLabelOnlyAccountbf72d3e0`
 *  in `translations/en.json`), so this tab doesn't invent a second phrasing. */
const OWNER_ONLY_BILLING_NOTE = 'Only account owners can manage billing.';

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
  /** Whether the current viewer holds `billing.write` on this account
   *  (`account_state.can_manage_billing`, see this file's header comment).
   *  Gates every MUTATING control — Subscribe, the Stripe portal button —
   *  independent of `billingEnabled`/`canPurchaseCredits`, which only gate
   *  whether the surrounding section is relevant at all. An `account.write`
   *  holder without `billing.write` (a non-owner admin) still sees every
   *  read-only section (Plan/wallet/spend, seat management) with this
   *  `false` — only the actions themselves disappear, replaced by
   *  `OWNER_ONLY_BILLING_NOTE`. */
  canManageBilling?: boolean;

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
  canManageBilling = true,
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
          {canManageBilling ? (
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
          ) : (
            <p className="text-muted-foreground text-xs">{OWNER_ONLY_BILLING_NOTE}</p>
          )}
        </section>
      ) : (
        <>
          {/* 1. Plan, wallet, and spend — always first (see the task brief).
              Read-only; visible to every account.write holder regardless of
              canManageBilling (see this file's header comment). */}
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

          {/* 2. Per-seat claim / seat management. The claim slot is only ever
              built by the container when canManageBilling is also true (it's
              a mutation) — seat management is a pure read-only display, so it
              carries no such gate. Each self-guards on whether it applies,
              same as the source file. */}
          {claimPerSeatSlot}
          {seatManagementSlot}

          {/* 3. Auto top-up — mutation, gated on canManageBilling too. */}
          {canPurchaseCredits && canManageBilling && (
            <section className="space-y-4">
              <SettingsSectionHeader title="Auto top-up" description="Never run out again" />
              <div className="bg-popover rounded-md border px-4 py-3">{autoTopupSlot}</div>
            </section>
          )}

          {/* 4. Buy credits — mutation, gated on canManageBilling too. */}
          {canPurchaseCredits && canManageBilling && (
            <section className="space-y-4">
              <SettingsSectionHeader title="Buy credits" description="One-time top-up" />
              <div className="bg-popover rounded-md border px-4 py-3">{creditTopupSlot}</div>
            </section>
          )}

          {/* 5. Billing portal — the Stripe billing portal doesn't exist
              without billing enabled (self-host with billing off); hide the
              whole section rather than let it 404/error on click. Opening
              the portal is a mutation (creates a Stripe session), so the
              button is replaced by the owner-only note when canManageBilling
              is false — the section itself stays visible so an admin still
              knows a portal exists. */}
          {billingEnabled ? (
            <section className="space-y-4">
              <SettingsSectionHeader
                title="Billing portal"
                description="Manage your subscription, payment methods, and invoices."
                action={
                  canManageBilling ? (
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
                  ) : undefined
                }
              />
              {!canManageBilling && (
                <p className="text-muted-foreground text-xs">{OWNER_ONLY_BILLING_NOTE}</p>
              )}
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}

/** Container entry point. Resolves the account id once, then nests a
 *  `BillingAccountProvider` seeded with it — see this file's header comment
 *  ("`useBillingAccountId()` divergence — fix round 1, finding 2") — so
 *  `useCreatePortalSession`, `AutoTopupCard`, and `CreditTopupSection`
 *  (mounted inside `BillingTabInner`) all resolve `useBillingAccountId()` to
 *  the SAME value this tab's own query/permission use. `resolved` is always
 *  `true`: unlike `project-shell.tsx`'s provider (whose `resolved` tracks a
 *  raw, fallback-less `project?.account_id`), `useSettingsAccountId` already
 *  folds in the store fallback, so its answer is always this tab's
 *  best-known value, never a "still don't know" state. */
export function BillingTab({ accountId }: { accountId?: string }) {
  const resolvedAccountId = useSettingsAccountId(accountId);
  return (
    <BillingAccountProvider accountId={resolvedAccountId ?? null} resolved>
      <BillingTabInner accountId={resolvedAccountId} />
    </BillingAccountProvider>
  );
}

/** Owns every hook (React Query, permission probe, auth) and renders
 *  `BillingTabView` with real data + handlers. Only ever mounted while this
 *  tab is active (`SettingsTabPane` in `settings-panel.tsx` returns `null`
 *  otherwise), so nothing here fetches on panel open. */
function BillingTabInner({ accountId: resolvedAccountId }: { accountId: string | undefined }) {
  // Whole-tab visibility — account.write, matching the source page's
  // `canWriteAccount` gate exactly (see this file's header comment). NOT
  // billing.write: that would hide the tab from every non-owner admin who
  // could see it before.
  const { allowed: canViewBilling } = usePermission(resolvedAccountId, 'account.write');
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
    enabled: billingEnabled && canViewBilling && !!session && !authLoading,
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

  // billing.write, sourced straight from the account-state response (see
  // this file's header comment) instead of a second IAM probe — the exact
  // `accountState?.can_manage_billing !== false` pattern
  // `global-upgrade-modal.tsx` already uses for the same field.
  const canManageBilling = accountState?.can_manage_billing !== false;

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
  if (!billingEnabled || !canViewBilling) return null;

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
      canManageBilling={canManageBilling}
      accountOverviewSlot={<AccountOverviewTab accountId={resolvedAccountId} />}
      claimPerSeatSlot={
        accountState?.can_claim_per_seat && canManageBilling ? (
          <ClaimPerSeatCard accountState={accountState} />
        ) : undefined
      }
      seatManagementSlot={
        subscribedToTeam && accountState ? (
          <SeatManagementCard accountState={accountState} />
        ) : undefined
      }
      autoTopupSlot={
        canPurchaseCredits && canManageBilling ? (
          <AutoTopupCard fetchSettings showSaveButton />
        ) : undefined
      }
      creditTopupSlot={
        canPurchaseCredits && canManageBilling ? <CreditTopupSection /> : undefined
      }
    />
  );
}

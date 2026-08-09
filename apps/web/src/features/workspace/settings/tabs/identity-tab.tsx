'use client';

/**
 * The Identity tab — SAML SSO + SCIM directory sync. Reuses
 * `components/iam/identity-intro.tsx`'s `IdentityIntro`,
 * `components/iam/sso-card.tsx`'s `SsoCard`, and
 * `components/iam/scim-card.tsx`'s `ScimCard` UNMODIFIED, through slots
 * (`introSlot`/`ssoSlot`/`scimSlot` below) — same reason
 * `groups-tab.tsx`/`roles-tab.tsx` thread their own real components through
 * a slot: all three call `useQuery`/`useMutation` internally, so none can
 * render under `renderToStaticMarkup`. Those three are the account page's
 * Identity pane (`app/(app)/accounts/[id]/page.tsx:603-619`).
 *
 * **The gate — matches the source exactly, not inferred from the tab name.**
 * `app/(app)/accounts/[id]/page.tsx`:
 *
 * - `:358 identity: canWriteAccount === true` — the WHOLE Identity pane
 *   requires `account.write`, same shape as `billing`/`usage`
 *   (`billing-tab.tsx`/`usage-tab.tsx`'s header comments) — NOT a narrower
 *   leaf like `role.create`. `IdentityTabInner` below returns `null` without
 *   it, placed after every hook, same "whole-tab gate" shape those two files
 *   already use.
 * - `:300 enterpriseIdentityEnabled = !!(entitlements?.sso ||
 *   entitlements?.scim)` — for an `account.write` holder, gates the PANE
 *   CONTENT, not visibility (`:603-619`): a non-entitled admin still reaches
 *   the pane, but its content is `EnterpriseUpsell` instead of the real
 *   cards — mirrors the server's `requireEntitlement('sso')` /
 *   `requireEntitlement('scim')` 402s. **This is an OR of two leaves, and
 *   neither one is `rbac`** — Groups/Roles gate on `!!entitlements?.rbac`
 *   (`groups-tab.tsx`/`roles-tab.tsx`'s header comments); Identity does not
 *   share that leaf at all. Getting this wrong (e.g. copying `rbacEnabled`)
 *   would hide the tab's content from an account entitled to exactly one of
 *   `sso`/`scim`.
 * - `:310 entitlementsLoading = !entitlements && accountStateQuery.isLoading`
 *   — while the account-state query is in flight, `:605-606` renders a
 *   `Skeleton` — NEITHER the real cards nor the upsell. Same
 *   `!resolvedAccountId` fold-in as `groups-tab.tsx`/`roles-tab.tsx` — see
 *   those files' header comments for why (a still-resolving
 *   `useSettingsAccountId` would otherwise flash the upsell for one frame
 *   even on an entitled account).
 *
 * `canWriteAccount` is sourced from `usePermission(resolvedAccountId,
 * 'account.write')` — the same leaf `billing-tab.tsx`/`usage-tab.tsx` probe
 * for their own whole-tab gate, as its own probe here since this task has no
 * sibling leaves to batch it with.
 *
 * **Account id.** `useSettingsAccountId(accountId)` — same shape as every
 * other Phase 3 tab; never `project?.account_id` alone.
 *
 * **The wizard links stay untouched.** `SsoCard`'s "Configure" button links
 * to `/accounts/${accountId}/sso-setup` (`components/iam/sso-card.tsx:247`)
 * and `ScimCard`'s "Guided setup" / per-provider "Guide" links go to
 * `/accounts/${accountId}/scim-setup` (`components/iam/scim-card.tsx:268,386`).
 * Both routes are still live; a later ticket (JAY-505) owns moving them
 * under `/settings/`. This tab does not modify `SsoCard`/`ScimCard`, so those
 * links are unchanged — repointing them at a `/settings/*` route that
 * doesn't exist yet would produce dead links today.
 *
 * `IdentityTabView` is the pure, props-only half — no hooks, no data
 * fetching. It only ever exercises the entitlement axis (loading /
 * non-entitled / entitled) — the `account.write` whole-tab gate lives in
 * `IdentityTabInner` (the container), which can't render under
 * `renderToStaticMarkup` with no providers mounted.
 * `identity-tab.test.tsx` documents this the same way `roles-tab.test.tsx`
 * never renders `RolesTab` (the container) directly, only `RolesTabView`.
 *
 * **Untestable here, by design (see the task brief's constraints):** every
 * SSO provider import/edit/delete mutation, every SCIM token mint/revoke,
 * every group-mapping create/delete, and the live "Provisioning health"
 * polling all need a live network and a real DOM. `bun test` has no DOM.
 * `identity-tab.test.tsx` covers what the pure view can prove statically:
 * which of the skeleton / `EnterpriseUpsell` / the three real slots renders
 * for each entitlement state.
 */

import type { ReactNode } from 'react';

import { EnterpriseUpsell } from '@/components/iam/enterprise-upsell';
import { IdentityIntro } from '@/components/iam/identity-intro';
import { ScimCard } from '@/components/iam/scim-card';
import { SsoCard } from '@/components/iam/sso-card';
import { SettingsSectionHeader } from '@/components/ui/settings-section-header';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/features/providers/auth-provider';
import { accountStateKeys } from '@/hooks/billing';
import { usePermission } from '@/lib/use-permission';
import { getAccountState, type AccountState } from '@kortix/sdk';
import { useQuery } from '@tanstack/react-query';

import { useSettingsAccountId } from '../use-settings-account-id';

export interface IdentityTabViewProps {
  /** Account-state query still in flight, or the accountId not yet
   *  resolved — see this file's header comment. Neither the real cards nor
   *  the upsell render while true; a skeleton does instead. */
  isLoading?: boolean;
  /** `!!(entitlements?.sso || entitlements?.scim)` — gates the real slots vs
   *  `EnterpriseUpsell`. An OR of two leaves, NOT `rbac` — see this file's
   *  header comment. */
  identityEnabled?: boolean;
  /** `IdentityIntro`, built by the container once an accountId is known —
   *  see this file's header comment for why it can't render under
   *  `renderToStaticMarkup`. Self-hides once either SSO or SCIM is
   *  configured (`identity-intro.tsx`), so it's positioned first. */
  introSlot?: ReactNode;
  /** `SsoCard` — see this file's header comment. */
  ssoSlot?: ReactNode;
  /** `ScimCard` — see this file's header comment. */
  scimSlot?: ReactNode;
}

/** Presentational only — no hooks, no data fetching, no store or Supabase
 *  read. Kept separate from `IdentityTab` so this renders under
 *  `renderToStaticMarkup` with no `QueryClientProvider` — see
 *  `RolesTabView`/`GroupsTabView` for the same split. Does NOT encode the
 *  `account.write` whole-tab gate — that lives in `IdentityTabInner`, see
 *  this file's header comment. */
export function IdentityTabView({
  isLoading = false,
  identityEnabled = false,
  introSlot,
  ssoSlot,
  scimSlot,
}: IdentityTabViewProps) {
  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-10">
      {isLoading ? (
        <div className="space-y-4">
          <SettingsSectionHeader
            title="Identity"
            description="Bring members in from your identity provider."
          />
          <Skeleton className="h-40 w-full rounded-md" />
        </div>
      ) : identityEnabled ? (
        <div className="space-y-3">
          {introSlot}
          {ssoSlot}
          {scimSlot}
        </div>
      ) : (
        <EnterpriseUpsell feature="identity" />
      )}
    </div>
  );
}

/** Container entry point. Resolves the account id once, then hands off to
 *  `IdentityTabInner` so every hook below only runs while this tab is
 *  actually mounted — `SettingsTabPane` in `settings-panel.tsx` guarantees
 *  that only happens while this tab is the active one. */
export function IdentityTab({ accountId }: { accountId?: string }) {
  const resolvedAccountId = useSettingsAccountId(accountId);
  return <IdentityTabInner accountId={resolvedAccountId} />;
}

function IdentityTabInner({ accountId: resolvedAccountId }: { accountId: string | undefined }) {
  const { session, isLoading: authLoading } = useAuth();
  // account.write — the whole-tab gate (see this file's header comment),
  // same leaf billing-tab.tsx/usage-tab.tsx probe for their own whole-tab
  // gate.
  const { allowed: canWriteAccount } = usePermission(resolvedAccountId, 'account.write');

  const { data: accountState, isLoading: isLoadingAccountState } = useQuery<AccountState>({
    queryKey: accountStateKeys.state(resolvedAccountId),
    queryFn: () => getAccountState({ accountId: resolvedAccountId }),
    // Only fetch entitlements once we know the viewer can even see this
    // pane — a plain member without account.write never needs this query.
    enabled: !!resolvedAccountId && canWriteAccount && !!session && !authLoading,
    staleTime: 1000 * 60 * 2,
    gcTime: 1000 * 60 * 15,
    refetchOnWindowFocus: false,
    refetchOnMount: true,
  });

  const entitlements = accountState?.tier?.entitlements;
  // OR of two leaves — neither is `rbac`. See this file's header comment.
  const identityEnabled = !!(entitlements?.sso || entitlements?.scim);
  const entitlementsLoading =
    !entitlements && (isLoadingAccountState || authLoading || !resolvedAccountId);

  // Whole-tab gate — account.write. Placed after every hook above so the
  // hook count never changes render to render (same shape as
  // BillingTabInner/UsageTabInner/RolesTabInner's own whole-tab gates).
  if (!canWriteAccount) return null;

  return (
    <IdentityTabView
      isLoading={entitlementsLoading}
      identityEnabled={identityEnabled}
      introSlot={
        resolvedAccountId ? <IdentityIntro accountId={resolvedAccountId} /> : undefined
      }
      ssoSlot={
        resolvedAccountId ? (
          <SsoCard accountId={resolvedAccountId} canManage={canWriteAccount} />
        ) : undefined
      }
      scimSlot={
        resolvedAccountId ? (
          <ScimCard accountId={resolvedAccountId} canManage={canWriteAccount} />
        ) : undefined
      }
    />
  );
}

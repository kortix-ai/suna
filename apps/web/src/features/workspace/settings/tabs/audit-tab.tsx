'use client';

/**
 * The Audit tab — the account's filterable activity log. Reuses
 * `components/iam/audit-tab.tsx`'s `AuditTab` export UNMODIFIED, through a
 * slot (`RealAuditTab` below, aliased to dodge the name collision with THIS
 * file's own `AuditTab`) — see `auditSlot` on `AuditTabViewProps`. That
 * component, and `components/iam/audit-webhooks-card.tsx`'s
 * `AuditWebhooksCard` (see below), are the account page's Audit pane
 * (`app/(app)/accounts/[id]/page.tsx:561-577`); both call
 * `useQuery`/`useMutation`/`useInfiniteQuery` internally, so neither can
 * render under `renderToStaticMarkup` — same reason `roles-tab.tsx`/
 * `identity-tab.tsx` thread their own real components through a slot (see
 * those files' header comments). This tab does NOT reimplement either, and
 * does NOT modify either — they still back the live `/accounts` page until
 * JAY-505 deletes `app/(app)/accounts/**`.
 *
 * **`AuditWebhooksCard` is folded in, matching the live composition
 * exactly** (`page.tsx:561-577`):
 *
 * ```
 * :561   <div className="space-y-10">        ← wrapper gap between blocks
 * :573   {!entitlementsLoading && auditEnabled && canWriteAccount ? (
 * :574     <AuditWebhooksCard accountId={account.account_id} canManage={canWriteAccount} />
 * :575   ) : null}
 * ```
 *
 * Its gate is STRICTER than the tab's: the tab is visible on `audit.read`
 * alone, but the card additionally needs `account.write` — it is all
 * mutations (create/rotate/delete webhook). A user with `audit.read` but not
 * `account.write` sees the log and no card. It also sits inside the SAME
 * `auditEnabled` entitlement gate as the log: non-entitled renders
 * `EnterpriseUpsell` and no card, entitled-but-loading renders neither.
 * `canWriteAccount` is resolved the same way `billing-tab.tsx`/
 * `usage-tab.tsx`/`identity-tab.tsx` resolve their own whole-tab
 * `account.write` probe (`usePermission(resolvedAccountId,
 * 'account.write')`) — not a second/invented mechanism, and not the same
 * probe as `canReadAudit` below (a `role.create`-style narrower leaf can
 * hold `audit.read` without `account.write`, so these two must stay
 * independent probes, exactly as `page.tsx`'s `canReadAudit` and
 * `canWriteAccount` are two independent entries in
 * `ACCOUNT_PERMISSION_PROBES`, not derived from one another).
 *
 * **The gate — matches the source exactly, not inferred from the tab name.**
 * `app/(app)/accounts/[id]/page.tsx`:
 *
 * - `:363 audit: canReadAudit === true` — the WHOLE Audit pane requires
 *   `audit.read`, NOT `account.write` — a narrower leaf than
 *   `billing`/`usage`/`identity`'s shared `account.write` gate, same
 *   "whole-tab gate, placed after every hook" shape those files already use.
 *   `AuditTabInner` below returns `null` without it.
 * - `:309 auditEnabled = !!entitlements?.auditAccess` — for an `audit.read`
 *   holder, gates the PANE CONTENT, not visibility (`:561-577`): a
 *   non-entitled admin still reaches the pane, but its content is
 *   `EnterpriseUpsell` instead of the real log — mirrors the server's
 *   `requireEntitlement('auditAccess')` 402. **This is its own leaf — NOT
 *   `rbac`** (Groups/Roles) **and NOT `sso || scim`** (Identity). Getting
 *   this wrong (e.g. copying `rbacEnabled`) would hide the log from an
 *   account entitled to exactly `auditAccess`.
 * - `:310 entitlementsLoading = !entitlements && accountStateQuery.isLoading`
 *   — while the account-state query is in flight, `:563-564` renders a
 *   `Skeleton` — NEITHER the real log, the upsell, nor the webhooks card.
 *   Same `!resolvedAccountId` fold-in as `groups-tab.tsx`/`roles-tab.tsx`/
 *   `identity-tab.tsx` — see those files' header comments for why.
 *
 * `canReadAudit` is sourced from `usePermission(resolvedAccountId,
 * 'audit.read')` — the same leaf the source page batches into
 * `ACCOUNT_PERMISSION_PROBES` (`page.tsx:142`).
 *
 * **Account id.** `useSettingsAccountId(accountId)` — same shape as every
 * other Phase 3 tab; never `project?.account_id` alone.
 *
 * `AuditTabView` is the pure, props-only half — no hooks, no data fetching.
 * It only ever exercises the entitlement axis (loading / non-entitled /
 * entitled) — the `audit.read` whole-tab gate lives in `AuditTabInner` (the
 * container), which can't render under `renderToStaticMarkup` with no
 * providers mounted. `audit-tab.test.tsx` documents this the same way
 * `identity-tab.test.tsx` never renders `IdentityTab` (the container)
 * directly, only `IdentityTabView`.
 *
 * **Untestable here, by design (see the task brief's constraints):** every
 * filter/search/export interaction, the infinite-scroll pagination, and the
 * expandable row detail all need a live network and a real DOM. `bun test`
 * has no DOM. `audit-tab.test.tsx` covers what the pure view can prove
 * statically: which of the skeleton / `EnterpriseUpsell` / the real slot
 * renders for each entitlement state.
 */

import type { ReactNode } from 'react';

import { AuditTab as RealAuditTab } from '@/components/iam/audit-tab';
import { AuditWebhooksCard } from '@/components/iam/audit-webhooks-card';
import { EnterpriseUpsell } from '@/components/iam/enterprise-upsell';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/features/providers/auth-provider';
import { accountStateKeys } from '@/hooks/billing';
import { usePermission } from '@/lib/use-permission';
import { getAccountState, type AccountState } from '@kortix/sdk';
import { useQuery } from '@tanstack/react-query';

import { SettingsTabHeader } from '../settings-tab-header';
import { useSettingsAccountId } from '../use-settings-account-id';

export interface AuditTabViewProps {
  /** Account-state query still in flight, or the accountId not yet
   *  resolved — see this file's header comment. Neither the real log, the
   *  upsell, nor the webhooks card render while true; a skeleton does
   *  instead. */
  isLoading?: boolean;
  /** `!!entitlements?.auditAccess` — gates the real slot vs
   *  `EnterpriseUpsell`. Its own leaf, NOT `rbac` and NOT `sso || scim` —
   *  see this file's header comment. */
  auditEnabled?: boolean;
  /** `account.write` — the webhooks card's OWN, stricter gate on top of
   *  `auditEnabled`. Also the value forwarded to `AuditWebhooksCard`'s own
   *  `canManage` prop — see this file's header comment ("`AuditWebhooksCard`
   *  is folded in"). Does NOT affect `auditSlot`'s visibility — a read-only
   *  `audit.read` holder still sees the log, just not this card. */
  canWriteAccount?: boolean;
  /** `RealAuditTab`, built by the container once an accountId is known —
   *  see this file's header comment for why it can't render under
   *  `renderToStaticMarkup`. */
  auditSlot?: ReactNode;
  /** `AuditWebhooksCard`, built by the container once an accountId is known
   *  — see this file's header comment. Rendered only when NOT loading, AND
   *  `auditEnabled`, AND `canWriteAccount` — matching `page.tsx:573` exactly. */
  webhooksSlot?: ReactNode;
}

/** Presentational only — no hooks, no data fetching, no store or Supabase
 *  read. Kept separate from `AuditTab` so this renders under
 *  `renderToStaticMarkup` with no `QueryClientProvider` — see
 *  `RolesTabView`/`IdentityTabView` for the same split. Does NOT encode the
 *  `audit.read` whole-tab gate — that lives in `AuditTabInner`, see this
 *  file's header comment. */
export function AuditTabView({
  isLoading = false,
  auditEnabled = false,
  canWriteAccount = false,
  auditSlot,
  webhooksSlot,
}: AuditTabViewProps) {
  return (
    <div className="mx-auto w-full max-w-2xl space-y-8">
      {/* `space-y-10` wrapper — matches `page.tsx:561`'s gap between the log
          block and the webhooks card exactly. Always rendered, independent
          of which branch below fires. Carries the pane heading as its first
          child so it shares this same rhythm. */}
      <div className="space-y-10">
        <SettingsTabHeader tab="audit" />
        {isLoading ? (
          <Skeleton className="h-64 w-full rounded-md" />
        ) : auditEnabled ? (
          auditSlot
        ) : (
          <EnterpriseUpsell feature="audit" />
        )}
        {!isLoading && auditEnabled && canWriteAccount ? webhooksSlot : null}
      </div>
    </div>
  );
}

/** Container entry point. Resolves the account id once, then hands off to
 *  `AuditTabInner` so every hook below only runs while this tab is actually
 *  mounted — `SettingsTabPane` in `settings-panel.tsx` guarantees that only
 *  happens while this tab is the active one. */
export function AuditTab({ accountId }: { accountId?: string }) {
  const resolvedAccountId = useSettingsAccountId(accountId);
  return <AuditTabInner accountId={resolvedAccountId} />;
}

function AuditTabInner({ accountId: resolvedAccountId }: { accountId: string | undefined }) {
  const { session, isLoading: authLoading } = useAuth();
  // audit.read — the whole-tab gate (see this file's header comment), NOT
  // account.write like billing/usage/identity.
  const { allowed: canReadAudit } = usePermission(resolvedAccountId, 'audit.read');
  // account.write — the webhooks card's OWN, stricter gate. Independent
  // probe from canReadAudit above, same as page.tsx's two separate entries
  // in ACCOUNT_PERMISSION_PROBES — see this file's header comment.
  const { allowed: canWriteAccount } = usePermission(resolvedAccountId, 'account.write');

  const { data: accountState, isLoading: isLoadingAccountState } = useQuery<AccountState>({
    queryKey: accountStateKeys.state(resolvedAccountId),
    queryFn: () => getAccountState({ accountId: resolvedAccountId }),
    // Only fetch entitlements once we know the viewer can even see this
    // pane — a member without audit.read never needs this query.
    enabled: !!resolvedAccountId && canReadAudit && !!session && !authLoading,
    staleTime: 1000 * 60 * 2,
    gcTime: 1000 * 60 * 15,
    refetchOnWindowFocus: false,
    refetchOnMount: true,
  });

  const entitlements = accountState?.tier?.entitlements;
  // Its own leaf — NOT rbac, NOT sso || scim. See this file's header comment.
  const auditEnabled = !!entitlements?.auditAccess;
  const entitlementsLoading =
    !entitlements && (isLoadingAccountState || authLoading || !resolvedAccountId);

  // Whole-tab gate — audit.read. Placed after every hook above so the hook
  // count never changes render to render (same shape as
  // BillingTabInner/UsageTabInner/RolesTabInner/IdentityTabInner's own
  // whole-tab gates).
  if (!canReadAudit) return null;

  return (
    <AuditTabView
      isLoading={entitlementsLoading}
      auditEnabled={auditEnabled}
      canWriteAccount={canWriteAccount}
      auditSlot={resolvedAccountId ? <RealAuditTab accountId={resolvedAccountId} /> : undefined}
      webhooksSlot={
        resolvedAccountId ? (
          <AuditWebhooksCard accountId={resolvedAccountId} canManage={canWriteAccount} />
        ) : undefined
      }
    />
  );
}

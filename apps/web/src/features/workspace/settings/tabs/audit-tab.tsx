'use client';

/**
 * The Audit tab — the account's filterable activity log. Reuses
 * `components/iam/audit-tab.tsx`'s `AuditTab` export UNMODIFIED, through a
 * slot (`RealAuditTab` below, aliased to dodge the name collision with THIS
 * file's own `AuditTab`) — see `auditSlot` on `AuditTabViewProps`. That
 * component is the account page's Audit pane
 * (`app/(app)/accounts/[id]/page.tsx:561-577`); it calls
 * `useQuery`/`useInfiniteQuery` internally (events, members, projects,
 * sessions), so it can't render under `renderToStaticMarkup` — same reason
 * `roles-tab.tsx`/`identity-tab.tsx` thread their own real components
 * through a slot (see those files' header comments). This tab does NOT
 * reimplement it, and does NOT modify it — it still backs the live
 * `/accounts` page.
 *
 * **Out of scope, deliberately.** `page.tsx:570-575` also renders
 * `AuditWebhooksCard` on this same section (entitled + `account.write`
 * only). The task brief's "Source" is `components/iam/audit-tab.tsx`
 * alone — `AuditWebhooksCard` is a separate component with its own gate and
 * isn't named there. Left for a later task to fold in explicitly rather than
 * assumed.
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
 *   `Skeleton` — NEITHER the real log nor the upsell. Same
 *   `!resolvedAccountId` fold-in as `groups-tab.tsx`/`roles-tab.tsx`/
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
import { EnterpriseUpsell } from '@/components/iam/enterprise-upsell';
import { SettingsSectionHeader } from '@/components/ui/settings-section-header';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/features/providers/auth-provider';
import { accountStateKeys } from '@/hooks/billing';
import { usePermission } from '@/lib/use-permission';
import { getAccountState, type AccountState } from '@kortix/sdk';
import { useQuery } from '@tanstack/react-query';

import { useSettingsAccountId } from '../use-settings-account-id';

export interface AuditTabViewProps {
  /** Account-state query still in flight, or the accountId not yet
   *  resolved — see this file's header comment. Neither the real log nor
   *  the upsell render while true; a skeleton does instead. */
  isLoading?: boolean;
  /** `!!entitlements?.auditAccess` — gates the real slot vs
   *  `EnterpriseUpsell`. Its own leaf, NOT `rbac` and NOT `sso || scim` —
   *  see this file's header comment. */
  auditEnabled?: boolean;
  /** `RealAuditTab`, built by the container once an accountId is known —
   *  see this file's header comment for why it can't render under
   *  `renderToStaticMarkup`. */
  auditSlot?: ReactNode;
}

/** Presentational only — no hooks, no data fetching, no store or Supabase
 *  read. Kept separate from `AuditTab` so this renders under
 *  `renderToStaticMarkup` with no `QueryClientProvider` — see
 *  `RolesTabView`/`IdentityTabView` for the same split. Does NOT encode the
 *  `audit.read` whole-tab gate — that lives in `AuditTabInner`, see this
 *  file's header comment. */
export function AuditTabView({ isLoading = false, auditEnabled = false, auditSlot }: AuditTabViewProps) {
  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-10">
      {isLoading ? (
        <div className="space-y-4">
          <SettingsSectionHeader
            title="Audit log"
            description="Reconstruct activity across people, agents, sessions, and connectors."
          />
          <Skeleton className="h-64 w-full rounded-md" />
        </div>
      ) : auditEnabled ? (
        auditSlot
      ) : (
        <EnterpriseUpsell feature="audit" />
      )}
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
      auditSlot={resolvedAccountId ? <RealAuditTab accountId={resolvedAccountId} /> : undefined}
    />
  );
}

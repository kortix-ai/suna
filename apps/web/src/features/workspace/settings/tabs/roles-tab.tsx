'use client';

/**
 * The Roles tab — custom-role capability matrix + policy assignments.
 * Reuses `components/iam/roles-tab.tsx`'s `RolesTab` export UNMODIFIED,
 * through a slot (`RealRolesTab` below) — see `rolesSlot` on
 * `RolesTabViewProps`. That component is the account page's Roles pane
 * (`app/(app)/accounts/[id]/page.tsx:551-555`); it calls
 * `useQuery`/`useMutation` internally (both the roles list and, nested
 * inside it, `PolicyAssignments`), so it can't render under
 * `renderToStaticMarkup` — same reason `groups-tab.tsx` reuses its own real
 * component through a slot (see that file's header comment).
 *
 * **The gate is asymmetric with Groups — three distinct checks, matching
 * the source exactly.** `app/(app)/accounts/[id]/page.tsx`:
 *
 * - `:357 roles: canManageRoles === true` — UNLIKE Groups (`:356 groups:
 *   true`, no permission gate at all), the WHOLE Roles pane requires
 *   `role.create`. `RolesTabInner` below returns `null` without it — the
 *   same "whole-tab gate, placed after every hook" shape
 *   `BillingTabInner`/`UsageTabInner` already use for
 *   `account.write`/`billing.write` (see those files' header comments), so
 *   a plain member never sees this pane render at all — not a skeleton, not
 *   the upsell, nothing.
 * - `:308 rbacEnabled = !!entitlements?.rbac` — for a `role.create` holder,
 *   gates the PANE CONTENT, not visibility (`:547-559`): a non-entitled
 *   admin still reaches the pane, but its content is `EnterpriseUpsell`
 *   instead of the real capability matrix — mirrors the server's
 *   `requireEntitlement('rbac')` 402 on the role create/update routes.
 * - `:310 entitlementsLoading = !entitlements && accountStateQuery.isLoading`
 *   — while the account-state query is in flight, `:548-549` renders a
 *   `Skeleton` — NEITHER the real pane nor the upsell. Same
 *   `!resolvedAccountId` fold-in as `groups-tab.tsx` — see that file's
 *   header comment for why.
 *
 * `canManageRoles` is sourced from `usePermission(resolvedAccountId,
 * 'role.create')` — the same `role.create` leaf the source page batches
 * into `ACCOUNT_PERMISSION_PROBES` (`page.tsx:143`).
 *
 * **Account id.** `useSettingsAccountId(accountId)` — same shape as every
 * other Phase 3 tab; never `project?.account_id` alone.
 *
 * `RolesTabView` is the pure, props-only half — no hooks, no data fetching.
 * It only ever exercises the entitlement axis (loading / non-entitled /
 * entitled) — the `role.create` whole-tab gate lives in `RolesTabInner`
 * (the container), which calls `useAuth`/`usePermission`/`useQuery` and so
 * can't render under `renderToStaticMarkup` with no providers mounted.
 * `roles-tab.test.tsx` documents this the same way `billing-tab.test.tsx`
 * never renders `BillingTab` (the container) directly, only
 * `BillingTabView`.
 *
 * **Untestable here, by design (see the task brief's constraints):** the
 * actual role create/edit/delete network round trips, the capability-matrix
 * checkbox interactions, and `PolicyAssignments`'s own mutations all need a
 * live network and a real DOM. `bun test` has no DOM. `roles-tab.test.tsx`
 * covers what the pure view can prove statically: which of the skeleton /
 * `EnterpriseUpsell` / the real slot renders for each entitlement state.
 */

import type { ReactNode } from 'react';

import { EnterpriseUpsell } from '@/components/iam/enterprise-upsell';
import { RolesTab as RealRolesTab } from '@/components/iam/roles-tab';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/features/providers/auth-provider';
import { accountStateKeys } from '@/hooks/billing';
import { usePermission } from '@/lib/use-permission';
import { getAccountState, type AccountState } from '@kortix/sdk';
import { useQuery } from '@tanstack/react-query';

import { SettingsTabHeader } from '../settings-tab-header';
import { useSettingsAccountId } from '../use-settings-account-id';

export interface RolesTabViewProps {
  /** Account-state query still in flight, or the accountId not yet
   *  resolved — see this file's header comment. Neither the real pane nor
   *  the upsell render while true; a skeleton does instead. */
  isLoading?: boolean;
  /** `!!entitlements?.rbac` — gates the real slot vs `EnterpriseUpsell`. */
  rbacEnabled?: boolean;
  /** `RealRolesTab`, built by the container once an accountId is known —
   *  see this file's header comment for why it can't render under
   *  `renderToStaticMarkup`. */
  rolesSlot?: ReactNode;
}

/** Presentational only — no hooks, no data fetching, no store or Supabase
 *  read. Kept separate from `RolesTab` so this renders under
 *  `renderToStaticMarkup` with no `QueryClientProvider` — see
 *  `GroupsTabView` for the same split. Does NOT encode the `role.create`
 *  whole-tab gate — that lives in `RolesTabInner`, see this file's header
 *  comment. */
export function RolesTabView({
  isLoading = false,
  rbacEnabled = false,
  rolesSlot,
}: RolesTabViewProps) {
  // `max-w-4xl` is the TABLE tier. `rolesSlot` is `components/iam/roles-tab.tsx`,
  // which renders a 5-column role table (Name / Type / Origin / Used by / actions).
  // See `tab-content-width.test.ts`.
  return (
    <div className="mx-auto w-full max-w-4xl space-y-8">
      <SettingsTabHeader tab="roles" />
      {isLoading ? (
        <Skeleton className="h-64 w-full rounded-md" />
      ) : rbacEnabled ? (
        rolesSlot
      ) : (
        <EnterpriseUpsell feature="roles" />
      )}
    </div>
  );
}

/** Container entry point. Resolves the account id once, then hands off to
 *  `RolesTabInner` so every hook below only runs while this tab is
 *  actually mounted — `SettingsTabPane` in `settings-panel.tsx` guarantees
 *  that only happens while this tab is the active one. */
export function RolesTab({ accountId }: { accountId?: string }) {
  const resolvedAccountId = useSettingsAccountId(accountId);
  return <RolesTabInner accountId={resolvedAccountId} />;
}

function RolesTabInner({ accountId: resolvedAccountId }: { accountId: string | undefined }) {
  const { session, isLoading: authLoading } = useAuth();
  // role.create — the whole-tab gate (see this file's header comment), NOT
  // merely a mutating-control gate the way group.create is for Groups.
  const { allowed: canManageRoles } = usePermission(resolvedAccountId, 'role.create');

  const { data: accountState, isLoading: isLoadingAccountState } = useQuery<AccountState>({
    queryKey: accountStateKeys.state(resolvedAccountId),
    queryFn: () => getAccountState({ accountId: resolvedAccountId }),
    // Only fetch entitlements once we know the viewer can even see this
    // pane — a plain member without role.create never needs this query.
    enabled: !!resolvedAccountId && canManageRoles && !!session && !authLoading,
    staleTime: 1000 * 60 * 2,
    gcTime: 1000 * 60 * 15,
    refetchOnWindowFocus: false,
    refetchOnMount: true,
  });

  const entitlements = accountState?.tier?.entitlements;
  const rbacEnabled = !!entitlements?.rbac;
  const entitlementsLoading =
    !entitlements && (isLoadingAccountState || authLoading || !resolvedAccountId);

  // Whole-tab gate — role.create. Placed after every hook above so the hook
  // count never changes render to render (same shape as
  // BillingTabInner/UsageTabInner's own whole-tab gates).
  if (!canManageRoles) return null;

  return (
    <RolesTabView
      isLoading={entitlementsLoading}
      rbacEnabled={rbacEnabled}
      rolesSlot={
        resolvedAccountId ? (
          <RealRolesTab
            accountId={resolvedAccountId}
            canManage={canManageRoles}
            rbacEnabled={rbacEnabled}
          />
        ) : undefined
      }
    />
  );
}

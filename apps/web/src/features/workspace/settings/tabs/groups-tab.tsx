'use client';

/**
 * The Groups tab — bulk-grant project access via account groups. Reuses
 * `components/iam/groups-tab.tsx`'s `GroupsTab` export UNMODIFIED, through a
 * slot (`RealGroupsTab` below) — see `groupsSlot` on `GroupsTabViewProps`.
 * That component is the account page's Groups pane
 * (`app/(app)/accounts/[id]/page.tsx:537-541`). It calls
 * `useQuery`/`useMutation`/`useRouter`/`useTranslations` internally, so it
 * can't render under `renderToStaticMarkup` — same reason
 * `billing-tab.tsx`/`usage-tab.tsx` thread their own hook-driven children
 * through slots instead of rendering them inline.
 *
 * **The gate — matches the source exactly, not inferred from the tab name.**
 * `app/(app)/accounts/[id]/page.tsx`:
 *
 * - `:356 groups: true` — the Groups tab/pane carries NO permission gate.
 *   Every member reaches it (unlike Roles — see `roles-tab.tsx`'s header
 *   comment, `:357`).
 * - `:308 rbacEnabled = !!entitlements?.rbac` — gates the PANE CONTENT, not
 *   visibility (`:536-544`). A non-entitled account sees `EnterpriseUpsell`
 *   in place of the real `GroupsTab` — the pane itself stays reachable —
 *   mirroring the server's `requireEntitlement('rbac')` 402 on the create
 *   route, so an admin never touches a control the backend would reject.
 * - `:310 entitlementsLoading = !entitlements && accountStateQuery.isLoading`
 *   — while the account-state query is in flight, `:534-535` renders a
 *   `Skeleton` — NEITHER the real pane nor the upsell. `GroupsTabInner`
 *   below folds in one more condition the source page never needed:
 *   `!resolvedAccountId` also counts as "loading". The source page never
 *   reaches this pane before `account` resolves (`page.tsx:406`), so its
 *   accountId is never transiently undefined; `useSettingsAccountId` can be,
 *   with no project open and the store fallback not yet hydrated (see
 *   `../use-settings-account-id.ts`'s header comment) — without this fold-in
 *   a mid-resolution mount would flash the Enterprise upsell for one frame
 *   even on an entitled account, exactly the bug the brief calls out.
 *
 * `canCreate` is sourced from `usePermission(resolvedAccountId,
 * 'group.create')` — the same `group.create` leaf the source page batches
 * into `ACCOUNT_PERMISSION_PROBES` (`page.tsx:141`), as its own probe here
 * since this task has no sibling leaves to batch it with.
 *
 * **Account id.** `useSettingsAccountId(accountId)` — same shape as every
 * other Phase 3 tab; never `project?.account_id` alone (see
 * `../use-settings-account-id.ts`'s header comment for why the fallback
 * exists).
 *
 * **The group detail page — decision, not deferral (see the task report for
 * the full reasoning).** `RealGroupsTab` still navigates to
 * `/accounts/${accountId}/groups/${groupId}` on row click and on create
 * (`components/iam/groups-tab.tsx:226,334`, unmodified) — that route
 * (`app/(app)/accounts/[id]/groups/[groupId]/page.tsx`, 1117 lines) is
 * untouched by this task and still live, so the link keeps working today
 * exactly as before. It should be RECREATED at `/settings/groups/[groupId]`
 * as its own standalone (non-modal) page once `/accounts/**` is deleted —
 * it is too large and too stateful (member/project-grant management, its
 * own sub-navigation) to fold into a `SettingsTabPane` the way this file's
 * list view could. This file makes no change toward that; it is out of
 * scope here.
 *
 * `GroupsTabView` is the pure, props-only half — no hooks, no data
 * fetching. `RealGroupsTab` renders through the `groupsSlot` prop, left
 * `undefined` by default — same pattern every other Phase 3 tab uses for its
 * hook-driven children.
 *
 * **Untestable here, by design (see the task brief's constraints):** the
 * actual create/delete-group network round trips, the search-filter
 * interaction, and the row-click navigation to the group detail page all
 * need a live network, `next/navigation`, and a real DOM. `bun test` has no
 * DOM. `groups-tab.test.tsx` covers what the pure view can prove statically:
 * which of the skeleton / `EnterpriseUpsell` / the real slot renders for
 * each of the three gate states — it does not, and cannot, click a row or
 * observe a network call.
 */

import type { ReactNode } from 'react';

import { EnterpriseUpsell } from '@/components/iam/enterprise-upsell';
import { GroupsTab as RealGroupsTab } from '@/components/iam/groups-tab';
import { SettingsSectionHeader } from '@/components/ui/settings-section-header';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/features/providers/auth-provider';
import { accountStateKeys } from '@/hooks/billing';
import { usePermission } from '@/lib/use-permission';
import { getAccountState, type AccountState } from '@kortix/sdk';
import { useQuery } from '@tanstack/react-query';

import { useSettingsAccountId } from '../use-settings-account-id';

export interface GroupsTabViewProps {
  /** Account-state query still in flight, or the accountId not yet
   *  resolved — see this file's header comment. Neither the real pane nor
   *  the upsell render while true; a skeleton does instead. */
  isLoading?: boolean;
  /** `!!entitlements?.rbac` — gates the real slot vs `EnterpriseUpsell`. */
  rbacEnabled?: boolean;
  /** `RealGroupsTab`, built by the container once an accountId is known —
   *  see this file's header comment for why it can't render under
   *  `renderToStaticMarkup`. */
  groupsSlot?: ReactNode;
}

/** Presentational only — no hooks, no data fetching, no store or Supabase
 *  read. Kept separate from `GroupsTab` so this renders under
 *  `renderToStaticMarkup` with no `QueryClientProvider` or router — see
 *  `BillingTabView`/`UsageTabView` for the same split. */
export function GroupsTabView({
  isLoading = false,
  rbacEnabled = false,
  groupsSlot,
}: GroupsTabViewProps) {
  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-10">
      {isLoading ? (
        <div className="space-y-4">
          <SettingsSectionHeader
            title="Groups"
            description="Bundle members together to grant project access in bulk."
          />
          <Skeleton className="h-64 w-full rounded-md" />
        </div>
      ) : rbacEnabled ? (
        groupsSlot
      ) : (
        <EnterpriseUpsell feature="groups" />
      )}
    </div>
  );
}

/** Container entry point. Resolves the account id once, then hands off to
 *  `GroupsTabInner` so every hook below only runs while this tab is
 *  actually mounted — `SettingsTabPane` in `settings-panel.tsx` guarantees
 *  that only happens while this tab is the active one. */
export function GroupsTab({ accountId }: { accountId?: string }) {
  const resolvedAccountId = useSettingsAccountId(accountId);
  return <GroupsTabInner accountId={resolvedAccountId} />;
}

function GroupsTabInner({ accountId: resolvedAccountId }: { accountId: string | undefined }) {
  const { session, isLoading: authLoading } = useAuth();
  // group.create — drives `RealGroupsTab`'s "Create a group" button and the
  // per-row delete option (`components/iam/groups-tab.tsx`'s `canCreate`
  // prop). Groups itself has no whole-pane permission gate (see this file's
  // header comment) — this only gates the mutating controls INSIDE the pane.
  const { allowed: canCreateGroup } = usePermission(resolvedAccountId, 'group.create');

  const { data: accountState, isLoading: isLoadingAccountState } = useQuery<AccountState>({
    queryKey: accountStateKeys.state(resolvedAccountId),
    queryFn: () => getAccountState({ accountId: resolvedAccountId }),
    enabled: !!resolvedAccountId && !!session && !authLoading,
    staleTime: 1000 * 60 * 2,
    gcTime: 1000 * 60 * 15,
    refetchOnWindowFocus: false,
    refetchOnMount: true,
  });

  const entitlements = accountState?.tier?.entitlements;
  const rbacEnabled = !!entitlements?.rbac;
  // See this file's header comment ("entitlementsLoading") for the
  // `!resolvedAccountId` fold-in beyond what the source page needed.
  const entitlementsLoading =
    !entitlements && (isLoadingAccountState || authLoading || !resolvedAccountId);

  return (
    <GroupsTabView
      isLoading={entitlementsLoading}
      rbacEnabled={rbacEnabled}
      groupsSlot={
        resolvedAccountId ? (
          <RealGroupsTab
            accountId={resolvedAccountId}
            canCreate={canCreateGroup}
            rbacEnabled={rbacEnabled}
          />
        ) : undefined
      }
    />
  );
}

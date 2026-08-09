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
 * **Fix round 1 — the terminal no-account state.** `entitlementsLoading`
 * folds in `!resolvedAccountId` (see above) so a still-resolving accountId
 * shows a skeleton instead of flashing the upsell. But `useSettingsAccountId`
 * has no signal for "this will NEVER resolve" — if `resolvedAccountId` stays
 * `undefined` forever, that fold-in alone spins the skeleton forever too,
 * which is a worse failure mode: an indefinite spinner reads as "the app is
 * broken" without ever saying so. Traced whether that is reachable:
 *
 * - `GET /v1/accounts` (`listAccounts`, the query `resolvedAccountId`
 *   ultimately traces back to via `useCurrentAccountStore`) bootstraps a
 *   personal account SYNCHRONOUSLY, inside the same request, whenever the
 *   caller has zero memberships (`apps/api/src/accounts/core/accounts.ts:
 *   58,76-100` — `if (memberships.length > 0) {...} ` else
 *   `bootstrapPersonalAccount(...)`; the bootstrap itself is idempotent,
 *   `onConflictDoNothing` — `accounts/core/bootstrap-personal-account.ts:
 *   24-29`). So a SUCCESSFUL `listAccounts` response is never an empty
 *   array for an authenticated user — confirmed by reading the route, not
 *   assumed.
 * - `SettingsPanel` (which mounts this tab) is only ever mounted by
 *   `ProjectShell` (`features/workspace/project-layout/project-shell.tsx:
 *   185,195` — `ProjectSidebar` and `SettingsPanel` as siblings).
 *   `app/(app)/settings/[tab]/page.tsx` never mounts `SettingsPanel` itself
 *   — it sets store state and immediately bounces to a project route
 *   (see that file's own header comment). `ProjectSidebar` renders
 *   `UserMenu`, which owns the SAME `['accounts']` query
 *   (`features/layout/user-menu.tsx:150-161`) that self-heals
 *   `selectedAccountId` once it resolves. So every reachable mount of this
 *   tab already has that identical query running alongside it.
 *
 * Conclusion: "resolved to genuinely zero accounts" is unreachable for a
 * successful fetch — but the FETCH ITSELF can fail (network/API outage) and
 * never resolve, which never triggers the self-heal and leaves
 * `resolvedAccountId` `undefined` forever. That failure mode IS reachable.
 * `GroupsTabInner` below runs its own `['accounts']` query (same key as
 * `UserMenu`'s — react-query dedupes it into the same cache entry rather
 * than firing a second request in every reachable mount path) purely to
 * detect this: `accountResolutionFailed` is true once auth has settled and
 * that query has itself settled (not loading) with either an error or,
 * defensively, zero rows. `GroupsTabView` renders an honest `ErrorState`
 * instead of an indefinite skeleton in that case — cheap insurance for a
 * branch proven unreachable via the happy path, in case the trace above is
 * ever wrong.
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
import { Button } from '@/components/ui/button';
import { SettingsSectionHeader } from '@/components/ui/settings-section-header';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/features/layout/section/error-state';
import { useAuth } from '@/features/providers/auth-provider';
import { accountStateKeys } from '@/hooks/billing';
import { usePermission } from '@/lib/use-permission';
import { getAccountState, listAccounts, type AccountState } from '@kortix/sdk';
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
  /** True once the container has concluded `resolvedAccountId` will never
   *  resolve — see this file's header comment ("Fix round 1 — the terminal
   *  no-account state"). Takes precedence over `isLoading`/`rbacEnabled`:
   *  renders an honest `ErrorState` instead of an indefinite skeleton. */
  accountResolutionFailed?: boolean;
  /** Retries the `['accounts']` fetch. Renders no action when omitted. */
  onRetryAccountResolution?: () => void;
}

/** Presentational only — no hooks, no data fetching, no store or Supabase
 *  read. Kept separate from `GroupsTab` so this renders under
 *  `renderToStaticMarkup` with no `QueryClientProvider` or router — see
 *  `BillingTabView`/`UsageTabView` for the same split. */
export function GroupsTabView({
  isLoading = false,
  rbacEnabled = false,
  groupsSlot,
  accountResolutionFailed = false,
  onRetryAccountResolution,
}: GroupsTabViewProps) {
  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-10">
      {accountResolutionFailed ? (
        <ErrorState
          size="sm"
          title="Couldn't determine your account"
          description="Refresh the page, or contact support if this keeps happening."
          action={
            onRetryAccountResolution ? (
              <Button variant="outline" size="sm" onClick={onRetryAccountResolution}>
                Retry
              </Button>
            ) : undefined
          }
        />
      ) : isLoading ? (
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

  // Same queryKey/queryFn as `UserMenu`'s `['accounts']` query
  // (`features/layout/user-menu.tsx:150-154`) — react-query dedupes this
  // into the SAME cache entry rather than firing a second network request
  // in every reachable mount path (see this file's header comment for why
  // that's always true here). Used ONLY to detect the terminal "will never
  // resolve" state below, never to resolve `resolvedAccountId` itself —
  // `useSettingsAccountId` stays the single source of truth for that.
  const accountsQuery = useQuery({
    queryKey: ['accounts'],
    queryFn: listAccounts,
    enabled: !!session && !authLoading,
    staleTime: 60_000,
  });

  // See this file's header comment ("Fix round 1 — the terminal no-account
  // state"). True only once auth has settled AND the accounts fetch has
  // itself settled (not loading) with either an error or, defensively,
  // zero rows — a state proven unreachable on the happy path (the API
  // always bootstraps one account) but cheap to guard against being wrong.
  const accountResolutionFailed =
    !resolvedAccountId &&
    !!session &&
    !authLoading &&
    !accountsQuery.isLoading &&
    (accountsQuery.isError || (accountsQuery.data?.length ?? 0) === 0);

  const entitlements = accountState?.tier?.entitlements;
  const rbacEnabled = !!entitlements?.rbac;
  // See this file's header comment ("entitlementsLoading") for the
  // `!resolvedAccountId` fold-in beyond what the source page needed.
  const entitlementsLoading =
    !accountResolutionFailed &&
    !entitlements &&
    (isLoadingAccountState || authLoading || !resolvedAccountId);

  return (
    <GroupsTabView
      isLoading={entitlementsLoading}
      rbacEnabled={rbacEnabled}
      accountResolutionFailed={accountResolutionFailed}
      onRetryAccountResolution={() => accountsQuery.refetch()}
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

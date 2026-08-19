'use client';

/**
 * The workspace-picker SUBMENU of the sidebar's account menu: search, the
 * current account's settings, every workspace in every account, and the create
 * row.
 *
 * Account settings appears twice, on purpose, and both are the same
 * destination:
 *
 * - as a labelled row above the list, which is how you FIND it;
 * - as what the already-active workspace row does when you click it, which is
 *   the click that used to do nothing at all (`resolveWorkspaceRowNavigation`).
 *
 * The second is not a hidden gesture — it is the row that carries the account
 * you are in, and the first row teaches the destination.
 *
 * Reached from "Switch Workspace" in that menu — a `DropdownMenuSub`, the same
 * shape as Theme and Help, so all three read as one family. Radix owns opening,
 * closing and the return path; this file is only what goes inside.
 *
 * Rendered INSIDE an open `DropdownMenuSubContent`, so it emits menu children
 * only: no `DropdownMenu`, no trigger, no portal of its own.
 */

import { GearSixIcon as CogOne, MagnifyingGlassIcon as Search } from '@phosphor-icons/react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useParams, usePathname, useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import { Input } from '@/components/ui/input';
import Loading from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/skeleton';
import {
  filterWorkspaceGroups,
  groupWorkspacesByAccount,
  resolveSwitcherAccountId,
  resolveWorkspaceRowNavigation,
} from '@/features/workspace/project-sidebar/workspace-grouping';
import { cn } from '@/lib/utils';
import { useCurrentAccountStore } from '@/stores/current-account-store';
import {
  shouldShowProjectSwitchLoading,
  useProjectSwitchStore,
} from '@/stores/project-switch-store';
import { listAccounts, listProjectsForAccount, type KortixProject } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { CheckCircleIcon as CheckCircleSolid } from '@phosphor-icons/react';

export function WorkspaceMenuSection() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useParams<{ id?: string }>();
  const { selectedAccountId, setSelectedAccountId } = useCurrentAccountStore();
  const beginSwitch = useProjectSwitchStore((s) => s.beginSwitch);
  const switchingToProjectId = useProjectSwitchStore((s) => s.targetProjectId);
  const [query, setQuery] = useState('');

  const activeProjectId = pathname?.startsWith('/projects/') ? params?.id : undefined;

  const accountsQuery = useQuery({
    queryKey: ['accounts'],
    queryFn: listAccounts,
    staleTime: 60_000,
  });

  // Every account the user belongs to, and every workspace in each. This menu is
  // the ONLY complete workspace directory now that the /projects index is gone,
  // so it lists all accounts' workspaces, not just the selected one.
  // `GET /projects` with no `account_id` scopes server-side to a single default
  // account (apps/api resolveProjectAccount -> resolveAccountId), so there is no
  // single unscoped call that returns everything — one listProjectsForAccount per
  // account, fanned out and flattened below.
  const accounts = useMemo(() => accountsQuery.data ?? [], [accountsQuery.data]);
  const workspaceQueries = useQueries({
    queries: accounts.map((account) => ({
      queryKey: qk.projects.list(account.account_id),
      queryFn: () => listProjectsForAccount(account.account_id),
      ...contract('inventory'),
    })),
  });

  // Loading until accounts themselves are known AND every account's workspaces
  // are in. Without `accountsQuery.isLoading` this is `false` while accounts are
  // still in flight (`workspaceQueries` starts as `[]`, and `[].some(...)` is
  // `false` by definition) — the view would paint "No workspaces yet" before it
  // had even asked how many accounts exist.
  const workspacesLoading = accountsQuery.isLoading || workspaceQueries.some((q) => q.isLoading);
  const allWorkspaces = workspaceQueries.flatMap((q) => q.data ?? []);

  // Accounts whose workspace fetch failed. `workspaceQueries[i]` belongs to
  // `accounts[i]` — both built from the same array in the same order — so this is
  // a zip by index, not a second fetch. A failed account still gets its group
  // header and a retry row instead of silently looking empty:
  // `groupWorkspacesByAccount` drops any account with zero workspaces, and
  // `undefined` data folds to `[]` on error, so without this the account would
  // vanish indistinguishably from "genuinely has no workspaces".
  const failedAccounts = accounts.flatMap((account, i) =>
    workspaceQueries[i].isError ? [{ account, result: workspaceQueries[i] }] : [],
  );

  const groups = useMemo(
    () =>
      groupWorkspacesByAccount({
        accounts,
        workspaces: allWorkspaces,
        activeWorkspaceId: activeProjectId ?? null,
      }),
    [accounts, allWorkspaces, activeProjectId],
  );
  const visibleGroups = useMemo(() => filterWorkspaceGroups(groups, query), [groups, query]);

  // The account "Account settings" opens, and the account every row in the
  // list below belongs to when there is only one. `null` while the user's
  // accounts are still unknown — the row is withheld rather than pointed at
  // `/accounts/null`. See `resolveSwitcherAccountId` for the order.
  const switcherAccountId = resolveSwitcherAccountId({
    accounts,
    workspaces: allWorkspaces,
    activeWorkspaceId: activeProjectId ?? null,
    selectedAccountId,
  });

  // A failed account never appears in `groups` (it has zero workspaces, and
  // `groupWorkspacesByAccount` drops those), so it must not count toward "empty"
  // either — that would show "No workspaces yet" over an account we simply failed
  // to load, instead of that account's own retry row.
  const isEmpty = visibleGroups.length === 0 && failedAccounts.length === 0;

  // No explicit close: these are `DropdownMenuItem`s, and Radix closes the menu
  // on select unless the handler calls `preventDefault`.
  //
  // Two destinations, not one — see `resolveWorkspaceRowNavigation`. The row
  // you are already in used to `return` here, so clicking the one row the menu
  // marks with a checkmark spent the click and did nothing; it now opens that
  // workspace's ACCOUNT settings. `beginSwitch` and the account-store write are
  // switch-only: there is no project switch to narrate, and the account is
  // already the selected one.
  const openWorkspaceRow = (project: KortixProject) => {
    const target = resolveWorkspaceRowNavigation(project, activeProjectId);
    if (target.kind === 'switch') {
      beginSwitch(project.project_id);
      // Keep the account store in step with the workspace actually being
      // opened; otherwise account-scoped surfaces keep answering for the
      // previous one.
      if (project.account_id !== selectedAccountId) setSelectedAccountId(project.account_id);
    }
    router.push(target.href);
  };

  return (
    <>
      {/* Always mounted. The /projects index is gone, so this view is the whole
          directory — a conditional search box would make workspace N+7
          unreachable for anyone with more than a handful. */}
      <div className="p-0.5">
        <div className="relative">
          <Search className="text-muted-foreground/50 pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find workspace…"
            // A Radix menu owns keyboard input: it runs typeahead on printable
            // keys to jump between items, moving focus off whatever you are
            // typing into. Stopping propagation keeps the keystrokes in the
            // field. Without it, searching drives the menu's selection instead
            // of this input — which is the whole reason a search box is here.
            onKeyDown={(e) => e.stopPropagation()}
            className="placeholder:text-muted-foreground/50 h-8 pr-2 pl-8 text-sm"
          />
        </div>
      </div>

      {/* Above the list, not in it. The account is what the workspaces below
          hang off, so it reads first — and it is deliberately NOT dressed as a
          workspace row: an icon where those carry an `EntityAvatar`, and a
          separator under it, so nothing here looks like a workspace you could
          switch to. Same icon + label dialect as the User Settings / Download
          App rows one level up in `workspace-switcher.tsx`.

          Withheld, not disabled, while the account id is unknown: a row that
          exists but goes nowhere is worse than one that arrives with the rest
          of the menu's content, and `selectedAccountId` is persisted so on a
          returning visit it is there from the first paint. */}
      {switcherAccountId ? (
        <>
          <div className="p-0.5">
            <DropdownMenuItem
              onSelect={() => router.push(`/accounts/${switcherAccountId}`)}
              className="cursor-pointer px-1.5"
            >
              <CogOne />
              <span className="min-w-0 flex-1 truncate">Account settings</span>
            </DropdownMenuItem>
          </div>
          <DropdownMenuSeparator />
        </>
      ) : null}

      {/* Bounded so a long list scrolls inside the submenu rather than growing
          it past the viewport. `min-h` stops the panel collapsing to a sliver on
          an empty or one-workspace account, where a search box above a single
          row would otherwise read as a rendering glitch. */}
      <div className="max-h-[640px] min-h-[120px] [scrollbar-width:none] overflow-y-auto [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
        {workspacesLoading ? (
          <div className="space-y-1 p-1">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-7 rounded-md" />
            ))}
          </div>
        ) : isEmpty ? (
          <div className="text-muted-foreground/60 px-2 py-3 text-xs">
            {query.trim() ? 'No workspaces match' : 'No workspaces yet'}
          </div>
        ) : (
          <>
            {visibleGroups.map((group) => (
              <DropdownMenuGroup key={group.accountId} className="p-0.5">
                <DropdownMenuLabel className="px-1.5 text-sm">
                  {group.accountName.replaceAll("'s Account", '')}
                </DropdownMenuLabel>
                {group.workspaces.map((workspace) => {
                  const active = workspace.project_id === activeProjectId;
                  // Only the row you clicked, and only until the URL is on it.
                  // Never the whole list — see `shouldShowProjectSwitchLoading`.
                  const loading = shouldShowProjectSwitchLoading(
                    switchingToProjectId,
                    workspace.project_id,
                    activeProjectId ?? null,
                  );
                  return (
                    <DropdownMenuItem
                      key={workspace.project_id}
                      disabled={loading}
                      onSelect={() => openWorkspaceRow(workspace)}
                      className={cn(
                        'group/workspace-row cursor-pointer px-1.5',
                        active && 'bg-muted/80',
                      )}
                    >
                      <EntityAvatar label={workspace.name} emoji={workspace.icon} size="sm" />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">
                        {workspace.name}
                      </span>
                      {loading ? (
                        <Loading className="text-muted-foreground size-3.5" />
                      ) : active ? (
                        // The active row navigates to account settings rather
                        // than switching, so pointing at it swaps the "you are
                        // here" check for the destination's own icon. Stacked
                        // rather than swapped in the tree so the trailing
                        // column keeps one width and the label never reflows.
                        <span className="relative size-4 shrink-0">
                          <CheckCircleSolid
                            weight="fill"
                            className="text-kortix-green absolute top-0 left-0 transition-opacity duration-150 group-data-[highlighted]/workspace-row:opacity-0"
                          />
                          <CogOne
                            aria-hidden
                            className="text-muted-foreground absolute top-0 left-0 opacity-0 transition-opacity duration-150 group-data-[highlighted]/workspace-row:opacity-100"
                          />
                        </span>
                      ) : null}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuGroup>
            ))}
            {/* Rendered after the successful groups, and NOT filtered by `query`:
                a search match could be hiding inside the account that failed, so
                hiding this on a search would tell the user something false. */}
            {failedAccounts.map(({ account, result }) => (
              <DropdownMenuGroup key={account.account_id}>
                <DropdownMenuLabel>{account.name?.trim() || 'Account'}</DropdownMenuLabel>
                <div className="text-muted-foreground flex w-full items-center gap-2 px-2.5 text-sm">
                  <span className="min-w-0 flex-1 truncate">Couldn&apos;t load</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={result.isFetching}
                    onClick={() => result.refetch()}
                    className="shrink-0"
                  >
                    {result.isFetching ? <Loading className="size-3.5 shrink-0" /> : 'Retry'}
                  </Button>
                </div>
              </DropdownMenuGroup>
            ))}
          </>
        )}
      </div>
    </>
  );
}

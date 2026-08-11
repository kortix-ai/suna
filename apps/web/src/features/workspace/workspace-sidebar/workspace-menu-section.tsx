'use client';

/**
 * The workspace-picker SUBMENU of the sidebar's account menu: search, every
 * workspace in every account, and the create row.
 *
 * Reached from "Switch Workspace" in that menu — a `DropdownMenuSub`, the same
 * shape as Theme and Help, so all three read as one family. Radix owns opening,
 * closing and the return path; this file is only what goes inside.
 *
 * Rendered INSIDE an open `DropdownMenuSubContent`, so it emits menu children
 * only: no `DropdownMenu`, no trigger, no portal of its own.
 */

import { MagnifyingGlassIcon as Search } from '@phosphor-icons/react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useParams, usePathname, useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
} from '@/components/ui/dropdown-menu';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import { Input } from '@/components/ui/input';
import Loading from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/skeleton';
import {
  filterWorkspaceGroups,
  groupWorkspacesByAccount,
} from '@/features/workspace/workspace-sidebar/workspace-grouping';
import { cn } from '@/lib/utils';
import { useCurrentAccountStore } from '@/stores/current-account-store';
import { useIsSwitchingWorkspace, useWorkspaceSwitchStore } from '@/stores/workspace-switch-store';
import { listAccounts, listWorkspacesForAccount, type KortixWorkspace } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { CheckCircleIcon as CheckCircleSolid } from '@phosphor-icons/react';

export function WorkspaceMenuSection() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useParams<{ id?: string }>();
  const { selectedAccountId, setSelectedAccountId } = useCurrentAccountStore();
  const beginSwitch = useWorkspaceSwitchStore((s) => s.beginSwitch);
  const switching = useIsSwitchingWorkspace();
  const [query, setQuery] = useState('');

  const activeWorkspaceId =
    pathname?.startsWith('/workspaces/') || pathname?.startsWith('/projects/')
      ? params?.id
      : undefined;

  const accountsQuery = useQuery({
    queryKey: ['accounts'],
    queryFn: listAccounts,
    staleTime: 60_000,
  });

  // Every account the user belongs to, and every workspace in each. This menu is
  // the ONLY complete workspace directory now that the /workspaces index is gone,
  // so it lists all accounts' workspaces, not just the selected one.
  // `GET /workspaces` with no `account_id` scopes server-side to a single default
  // account through the API's account resolver, so there is no
  // single unscoped call that returns everything — one listWorkspacesForAccount per
  // account, fanned out and flattened below.
  const accounts = useMemo(() => accountsQuery.data ?? [], [accountsQuery.data]);
  const workspaceQueries = useQueries({
    queries: accounts.map((account) => ({
      queryKey: qk.workspaces.list(account.account_id),
      queryFn: () => listWorkspacesForAccount(account.account_id),
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
  const failedAccounts = accounts
    .map((account, i) => ({ account, result: workspaceQueries[i] }))
    .filter(({ result }) => result.isError);

  const groups = useMemo(
    () =>
      groupWorkspacesByAccount({
        accounts,
        workspaces: allWorkspaces,
        activeWorkspaceId: activeWorkspaceId ?? null,
      }),
    [accounts, allWorkspaces, activeWorkspaceId],
  );
  const visibleGroups = useMemo(() => filterWorkspaceGroups(groups, query), [groups, query]);

  // A failed account never appears in `groups` (it has zero workspaces, and
  // `groupWorkspacesByAccount` drops those), so it must not count toward "empty"
  // either — that would show "No workspaces yet" over an account we simply failed
  // to load, instead of that account's own retry row.
  const isEmpty = visibleGroups.length === 0 && failedAccounts.length === 0;

  // No explicit close: these are `DropdownMenuItem`s, and Radix closes the menu
  // on select unless the handler calls `preventDefault`.
  const switchWorkspace = (workspace: KortixWorkspace) => {
    if (workspace.workspace_id === activeWorkspaceId) return;
    beginSwitch(workspace.workspace_id);
    // Keep the account store in step with the workspace actually being opened;
    // otherwise account-scoped surfaces keep answering for the previous one.
    if (workspace.account_id !== selectedAccountId) setSelectedAccountId(workspace.account_id);
    router.push(`/workspaces/${workspace.workspace_id}`);
  };

  return (
    <>
      {/* Always mounted. The /workspaces index is gone, so this view is the whole
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
                  const active = workspace.workspace_id === activeWorkspaceId;
                  const loading = switching && workspace.workspace_id !== activeWorkspaceId;
                  return (
                    <DropdownMenuItem
                      key={workspace.workspace_id}
                      disabled={loading}
                      onSelect={() => switchWorkspace(workspace)}
                      className={cn('cursor-pointer px-1.5', active && 'bg-muted/80')}
                    >
                      <EntityAvatar label={workspace.name} emoji={workspace.icon} size="sm" />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">
                        {workspace.name}
                      </span>
                      {loading ? (
                        <Loading className="text-muted-foreground size-3.5" />
                      ) : active ? (
                        <CheckCircleSolid
                          weight="fill"
                          className="text-kortix-green size-3.5 shrink-0"
                        />
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

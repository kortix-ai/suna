import { useCreatableAccounts } from '../new/use-creatable-accounts';
import { workspaceAccountLabel } from './workspace-grouping';
import { useAccountsList } from '../../internal/hooks/account/use-accounts-list';
import { useTranslations } from '../../i18n';
import { listProjectsForAccount } from '@kortix/sdk';
import { contract, qk, useCaptureWorkspace } from '@kortix/sdk/react';
import { useQueries } from '@tanstack/react-query';
import { useMemo } from 'react';
import {
  filterWorkspaceGroups,
  groupWorkspacesByAccount,
  resolveSwitcherAccountId,
} from './workspace-grouping';

export function useWorkspaceMenuModel(
  activeProjectId: string | undefined,
  selectedAccountId: string | null,
  query: string,
) {
  const t = useTranslations('sidebar');
  const accountsQuery = useAccountsList();

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

  // Accounts the user may actually create a project in — the same owner/admin
  // rule `/new` enforces (`filterCreatableAccounts`) and the API gates on
  // (`ACCOUNT_ACTIONS.PROJECT_CREATE`, 403 "Owner or admin role required").
  // Offering the create row to a plain member would dead-end in that 403.
  const creatableAccounts = useCreatableAccounts(accounts);
  const creatableAccountIds = useMemo(
    () => new Set(creatableAccounts.map((account) => account.account_id)),
    [creatableAccounts],
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
  // `groupWorkspacesByAccount` builds its groups from the PROJECTS it is given,
  // so an account with none never becomes a group — and an account with no
  // project is exactly the one you most want to create a project in. Seed those
  // here rather than changing that function: its "drops accounts that have no
  // workspaces" contract is pinned by `workspace-grouping.test.ts`, and the
  // list below is the only place that wants them back.
  //
  // A FAILED account is deliberately excluded: `failedAccounts` already renders
  // its own header + retry row, and an errored fetch folds to `[]`, so seeding
  // it here would render that account twice — once as "empty", once as failed.
  const groupsWithEmptyAccounts = useMemo(() => {
    const present = new Set(groups.map((group) => group.accountId));
    const failed = new Set(failedAccounts.map(({ account }) => account.account_id));
    const seeded = creatableAccounts
      .filter((account) => !present.has(account.account_id) && !failed.has(account.account_id))
      .map((account) => ({
        accountId: account.account_id,
        accountName: workspaceAccountLabel(account.name, t('workspace.account'), false),
        workspaces: [],
      }));
    return seeded.length > 0 ? [...groups, ...seeded] : groups;
  }, [groups, creatableAccounts, failedAccounts, t]);

  const visibleGroups = useMemo(
    () => filterWorkspaceGroups(groupsWithEmptyAccounts, query),
    [groupsWithEmptyAccounts, query],
  );

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

  // Kortix Capture is an account feature: the menu links to it once the
  // account has it on.
  const captureOn = useCaptureWorkspace(switcherAccountId ?? null).data?.enabled ?? false;

  // A failed account never appears in `groups` (it has zero workspaces, and
  // `groupWorkspacesByAccount` drops those), so it must not count toward "empty"
  // either — that would show "No workspaces yet" over an account we simply failed
  // to load, instead of that account's own retry row.
  // "No projects yet" is about PROJECTS, not groups. Seeding a group for an
  // empty creatable account (above) makes `visibleGroups` non-empty for a user
  // who owns accounts but no project at all, which would silently retire this
  // state — so count the projects inside the groups, not the groups.
  const isEmpty =
    visibleGroups.every((group) => group.workspaces.length === 0) && failedAccounts.length === 0;

  return {
    workspacesLoading,
    failedAccounts,
    creatableAccountIds,
    visibleGroups,
    switcherAccountId,
    isEmpty,
    captureOn,
  };
}

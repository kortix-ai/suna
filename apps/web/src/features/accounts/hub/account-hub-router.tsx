'use client';

/**
 * The account hub, as a router (Workspaces ux.md section 4).
 *
 * The hub used to be a full-screen modal over the page (`?accountId=`). Its
 * panes are sections of Workspace settings now (`/workspaces/<id>/admin/…`), so
 * this component draws nothing. It does two things:
 *
 * 1. registers the navigator `openAccountPanel` and `HubLink` use: a hub
 *    place opens the matching section of the current workspace in place;
 * 2. resolves a URL that still carries `?accountId=` (an old bookmark, an
 *    email, a pasted link, a cmd-clicked `HubLink`) to that section, with
 *    `router.replace`, so Back does not return to the dead address.
 *
 * "The current workspace" is the one on screen when it belongs to the
 * account, else the account's most recently opened project
 * (`pickWorkspaceForAccount`). An account with no workspace the caller can
 * open lands on the chooser.
 *
 * Mounted once, in `app/(app)/layout.tsx`, above every authenticated route.
 */

import { getProject, listProjectsForAccount, type KortixProject } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect } from 'react';

import {
  ACCOUNT_PANEL_PARAM,
  forgetPushedEntry,
  hubParamsFromUrl,
  hubTarget,
  setAccountHubNavigator,
  type HubTarget,
} from '@kortix/ui/internal/stores/account-panel-store';
import { setAccountHubImporter } from '@kortix/ui/internal/account-hub/account-hub-entry';
import {
  pickWorkspaceForAccount,
  routeProjectIdOf,
  workspaceSettingsHref,
} from '@kortix/ui/internal/account-hub/workspace-settings-route';

// `HubLink` warms the account panes' chunk on pointer intent: the same
// specifier `project-admin-route.tsx` lazy-loads, so the registry dedupes it.
setAccountHubImporter(() => import('@/features/workspace/settings/workspace-account-pane'));

/** What the cache already knows: no request. */
function pickFromCache(client: QueryClient, accountId: string, routeProjectId: string | null): string | null {
  const routeProject = routeProjectId
    ? client.getQueryData<KortixProject>(qk.project.summary(routeProjectId))
    : undefined;
  return pickWorkspaceForAccount({
    accountId,
    routeProjectId,
    routeProjectAccountId: routeProject?.account_id ?? null,
    projects: client.getQueryData<KortixProject[]>(qk.projects.list(accountId)),
  });
}

/** The same answer, reading what the cache lacks. */
async function pickWithReads(
  client: QueryClient,
  accountId: string,
  routeProjectId: string | null,
): Promise<string | null> {
  if (!accountId) return null;
  const [routeProject, projects] = await Promise.all([
    routeProjectId
      ? client
          .fetchQuery({
            queryKey: qk.project.summary(routeProjectId),
            queryFn: () => getProject(routeProjectId),
            ...contract('config'),
          })
          .catch(() => null)
      : null,
    client
      .fetchQuery({
        queryKey: qk.projects.list(accountId),
        queryFn: () => listProjectsForAccount(accountId),
        ...contract('inventory'),
      })
      .catch(() => undefined),
  ]);
  return pickWorkspaceForAccount({
    accountId,
    routeProjectId,
    routeProjectAccountId: routeProject?.account_id ?? null,
    projects,
  });
}

export function AccountHubRouter() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const routeProjectId = routeProjectIdOf(pathname);

  useEffect(() => {
    setAccountHubNavigator((target: HubTarget) => {
      const projectId = pickFromCache(queryClient, target.accountId, routeProjectId);
      if (!projectId) return false;
      router.push(workspaceSettingsHref(projectId, target));
      return true;
    });
    return () => setAccountHubNavigator(null);
  }, [queryClient, routeProjectId, router]);

  const accountParam = searchParams.get(ACCOUNT_PANEL_PARAM);
  const hubQuery = accountParam === null ? '' : hubParamsFromUrl(searchParams).toString();
  useEffect(() => {
    if (accountParam === null) return;
    let cancelled = false;
    const target = hubTarget(accountParam, Object.fromEntries(new URLSearchParams(hubQuery).entries()));
    void pickWithReads(queryClient, accountParam, routeProjectId).then((projectId) => {
      if (cancelled) return;
      // `replace` overwrites the entry the hub pushed, if it pushed one.
      forgetPushedEntry();
      router.replace(projectId ? workspaceSettingsHref(projectId, target) : '/workspaces');
    });
    return () => {
      cancelled = true;
    };
  }, [accountParam, hubQuery, queryClient, routeProjectId, router]);

  return null;
}

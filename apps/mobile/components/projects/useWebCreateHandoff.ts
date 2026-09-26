/**
 * Create on the web, come back to the result (KRTX-246). Mobile runs no
 * project create, no account create, and no GitHub connect or import: every
 * create entry point (the Projects page's New, the switcher's `+` and "New
 * account", first-run `/new`) opens web's page for it in an in-app auth
 * session (`newProjectWebUrl` / `newAccountWebUrl`,
 * `lib/projects/web-project-links.ts`).
 *
 * `open(url)` is `createWebCreateRunner` (`lib/projects/web-create.ts`,
 * bun-tested) wired to React Query and `expo-web-browser`: snapshot every
 * account's projects while the browser opens, wait for the user to close it,
 * invalidate accounts + projects, fetch fresh lists and diff. It resolves to
 * the project that did not exist before (the newest, if the user made
 * several), the account that did not exist before, and the fresh lists
 * (`after`, for first run). The caller opens the project; a new account with
 * no project is only selected. `pending` is true for the whole round trip.
 */

import { useCallback, useMemo, useState } from 'react';
import * as WebBrowser from 'expo-web-browser';
import { useQueryClient } from '@tanstack/react-query';

import { projectKeys } from '@/lib/projects/hooks';
import { invalidateAfterProjectCreation } from '@/lib/projects/project-mutation-cache';
import {
  listAccounts,
  listProjectsForAccount,
  type KortixAccount,
  type KortixProject,
} from '@/lib/projects/projects-client';
import { createWebCreateRunner, type WebCreateOutcome } from '@/lib/projects/web-create';
import { WEB_CREATE_RETURN_URL } from '@/lib/projects/web-project-links';

export type WebCreateResult = WebCreateOutcome<KortixAccount, KortixProject>;

export function useWebCreateHandoff() {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);

  // Every account's projects, fetched now, never from cache (`staleTime: 0`).
  const fetchSnapshot = useCallback(async () => {
    const accounts = await queryClient.fetchQuery({
      queryKey: projectKeys.accounts,
      queryFn: listAccounts,
      staleTime: 0,
    });
    const lists = await Promise.all(
      accounts.map((account) =>
        queryClient.fetchQuery({
          queryKey: projectKeys.projects(account.account_id),
          queryFn: () => listProjectsForAccount(account.account_id),
          staleTime: 0,
        })
      )
    );
    return { accounts, projects: lists.flat() };
  }, [queryClient]);

  const runner = useMemo(
    () =>
      createWebCreateRunner<KortixAccount, KortixProject>({
        fetchSnapshot,
        openBrowser: (url) => WebBrowser.openAuthSessionAsync(url, WEB_CREATE_RETURN_URL),
        invalidate: () => {
          void queryClient.invalidateQueries({ queryKey: projectKeys.accounts });
          invalidateAfterProjectCreation(queryClient);
        },
        onPendingChange: setPending,
      }),
    [queryClient, fetchSnapshot]
  );

  // `refresh`: the same snapshot without the browser ("I already created one").
  return { open: runner.run, pending, refresh: fetchSnapshot };
}

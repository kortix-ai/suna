'use client';

/**
 * Seed `useCurrentAccountStore`'s `selectedAccountId` from the user's real
 * accounts, and re-seed it if the stored id is not one of them.
 *
 * `selectedAccountId` is persisted in `localStorage`, so on a browser that has
 * ever used the app it is already set. On a BRAND NEW sign-in it is `null`, and
 * every account-scoped settings tab resolves its account through
 * `useSettingsAccountId` — `project?.account_id ?? selectedAccountId` — so a
 * surface mounted with no project AND no seeded id cannot resolve an account at
 * all. `usePermission(undefined, 'account.write')` then reports `allowed:
 * false` (its documented fail-closed default, `lib/use-permission.ts:26-27`),
 * which renders Billing/Usage/Identity/Audit/API keys/Organization as EMPTY —
 * indistinguishable from "you lack permission".
 *
 * This lived inline in `features/layout/user-menu.tsx` and was reachable only
 * because `ProjectSidebar` renders `UserMenu` next to every `SettingsPanel`
 * mount. `app/(app)/settings*` mounts the panel with no sidebar, so the effect
 * had to become callable on its own rather than be copied — see
 * `features/workspace/settings/standalone-settings-route.tsx`.
 *
 * Idempotent and safe to call from more than one mounted component: the
 * `['accounts']` query key and `staleTime` match `UserMenu`'s, so React Query
 * serves both from one fetch, and the write is skipped once the stored id is
 * valid.
 */

import { useEffect } from 'react';

import { useCurrentAccountStore } from '@/stores/current-account-store';
import { listAccounts } from '@kortix/sdk';
import { useQuery } from '@tanstack/react-query';

export function useEnsureSelectedAccount(): void {
  const selectedAccountId = useCurrentAccountStore((s) => s.selectedAccountId);
  const setSelectedAccountId = useCurrentAccountStore((s) => s.setSelectedAccountId);

  const accountsQuery = useQuery({
    queryKey: ['accounts'],
    queryFn: listAccounts,
    staleTime: 60_000,
  });

  useEffect(() => {
    const accounts = accountsQuery.data;
    if (!accounts?.length) return;
    if (!selectedAccountId || !accounts.find((a) => a.account_id === selectedAccountId)) {
      setSelectedAccountId(accounts[0].account_id);
    }
  }, [accountsQuery.data, selectedAccountId, setSelectedAccountId]);
}

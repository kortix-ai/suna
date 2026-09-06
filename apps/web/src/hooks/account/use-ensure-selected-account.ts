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
 * This lived inline in `features/layout/user-menu.tsx`, back when a `UserMenu`
 * sat in the project sidebar's footer next to every `SettingsPanel` mount. That
 * footer menu is gone. `ProjectSidebar` now renders `WorkspaceSwitcher`
 * (`features/workspace/project-sidebar/project-sidebar.tsx:116`) and no
 * `UserMenu` at all, and `UserMenu`'s single remaining mount is the app header
 * (`features/layout/app-header.tsx:108`), which only the `app/(app)/accounts`
 * tree renders — and that tree has no `SettingsPanel` in it. So the effect had to become
 * callable on its own rather than be copied, and each of the three surfaces
 * that needs it calls it directly:
 *
 * - `WorkspaceSwitcher`, for the project-shell panel mount
 *   (`project-layout/project-shell.tsx:195`);
 * - `StandaloneSettingsRoute`, for the project-less panel mount at
 *   `app/(app)/settings*` (`features/workspace/settings/standalone-settings-route.tsx`);
 * - `UserMenu`, for the accounts pages.
 *
 * Idempotent and safe to call from more than one mounted component: the
 * shared `useAccountsList()` hook is the same query every other caller reads,
 * so React Query serves them all from one fetch, and the write is skipped once
 * the stored id is valid.
 */

import { useEffect } from 'react';

import { useAccountsList } from '@/hooks/account/use-accounts-list';
import { useCurrentAccountStore } from '@/stores/current-account-store';

export function useEnsureSelectedAccount(): void {
  const selectedAccountId = useCurrentAccountStore((s) => s.selectedAccountId);
  const setSelectedAccountId = useCurrentAccountStore((s) => s.setSelectedAccountId);

  const accountsQuery = useAccountsList();

  useEffect(() => {
    const accounts = accountsQuery.data;
    if (!accounts?.length) return;
    if (!selectedAccountId || !accounts.find((a) => a.account_id === selectedAccountId)) {
      setSelectedAccountId(accounts[0].account_id);
    }
  }, [accountsQuery.data, selectedAccountId, setSelectedAccountId]);
}

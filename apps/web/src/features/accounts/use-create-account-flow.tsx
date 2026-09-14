'use client';

/**
 * Create an account, from any surface — the ONE copy of what happens after.
 *
 * Three surfaces offer it: the project sidebar's switcher, the account hub's
 * sidebar, and the hub's account-list pane. Each used to carry its own copy of
 * the success path, and a copy that drifts is how account creation stopped
 * working once already. Same shape as `useLogoutFlow`: an opener plus the
 * dialog, which the caller renders as a sibling of its trigger.
 *
 * After a create, every surface lands on `/new` scoped to the new account —
 * NOT the landing door. The door opens the first project found in ANY account
 * (`resolve-landing-destination.ts`), so a brand-new empty account falls
 * through to a different account's project, and `projects/start/page.tsx` then
 * heals the persisted selection to THAT account, undoing the switch below. A
 * new account's honest next step is its first project.
 */

import { CreateAccountModal } from '@/features/accounts/create-account-modal';
import { newWorkspacePathForAccount } from '@/features/workspace/new/account-param';
import { useAccountsQueryKey } from '@/hooks/account/use-accounts-list';
import { useAdminRole } from '@/hooks/admin/use-admin-role';
import { isAccountCreationRestricted } from '@/lib/config';
import { forgetPushedEntry } from '@/stores/account-panel-store';
import { useCurrentAccountStore } from '@/stores/current-account-store';
import { type KortixAccount } from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function useCreateAccountFlow({ insideHub }: { insideHub: boolean }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { setSelectedAccountId } = useCurrentAccountStore();
  // The exact key the account list reads, for the seed below.
  const accountsQueryKey = useAccountsQueryKey();
  const [open, setOpen] = useState(false);
  const { data: adminRole } = useAdminRole();

  // Self-host hides the affordance for non-admins when account creation is
  // restricted — admins are exempt (see `isAccountCreationRestricted()` /
  // KORTIX_RESTRICT_ACCOUNT_CREATION). The backend 403
  // (`account_creation_restricted`) is the authoritative gate; this only avoids
  // offering an affordance the person cannot use.
  const canCreateAccount = !isAccountCreationRestricted() || Boolean(adminRole?.isAdmin);

  const onCreated = (account: KortixAccount) => {
    // The reader's OWN key, not a hand-built one: writer and reader on
    // different keys is silent — the create appears to succeed and the list
    // never changes.
    queryClient.setQueryData<KortixAccount[]>(accountsQueryKey, (accounts) => {
      const current = accounts ?? [];
      return current.some((item) => item.account_id === account.account_id)
        ? current.map((item) => (item.account_id === account.account_id ? account : item))
        : [account, ...current];
    });
    // `scope()`, not `list(userId)`: the "account list changed" prefix, which
    // reaches the only slot that can be live without re-deriving whose it is.
    void queryClient.invalidateQueries({ queryKey: qk.accounts.scope() });
    setSelectedAccountId(account.account_id);
    // Every account's project list, and the accountless slot. Account creation
    // is rare — over-invalidating costs nothing measurable.
    void queryClient.invalidateQueries({ queryKey: qk.projects.scope() });

    const destination = newWorkspacePathForAccount(account.account_id);
    if (insideHub) {
      // The hub modal pushed ONE history entry. `replace` overwrites it, which
      // both closes the modal and leaves Back pointing where the person
      // started — so a later `closeAccountPanel` must not pop it as well.
      forgetPushedEntry();
      router.replace(destination);
      return;
    }
    router.push(destination);
  };

  return {
    canCreateAccount,
    openCreateAccount: () => setOpen(true),
    createAccountDialog: (
      <CreateAccountModal open={open} onOpenChange={setOpen} onCreated={onCreated} />
    ),
  };
}

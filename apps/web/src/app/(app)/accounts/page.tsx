'use client';

import { ConnectingScreen } from '@/components/dashboard/connecting-screen';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { useSignedOutRedirect } from '@/lib/auth/use-signed-out-redirect';
import { CreateAccountModal } from '@/features/accounts/create-account-modal';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { useAuth } from '@/features/providers/auth-provider';
import { useAccountsList, useAccountsQueryKey } from '@/hooks/account/use-accounts-list';
import { useAdminRole } from '@/hooks/admin/use-admin-role';
import { isAccountCreationRestricted } from '@/lib/config';
import { useCurrentAccountStore } from '@/stores/current-account-store';
import { type KortixAccount } from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';
import {
  CaretRightIcon as ChevronRight,
  PlusIcon as Plus,
  UsersIcon as Users,
} from '@phosphor-icons/react';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { PROJECT_LANDING_PATH } from '@/lib/onboarding/landing-destination';

export default function AccountsPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user, isLoading: authLoading } = useAuth();
  const { selectedAccountId, setSelectedAccountId } = useCurrentAccountStore();
  const [createOpen, setCreateOpen] = useState(false);
  const { data: adminRole } = useAdminRole();
  // Self-host: hide "New account" affordances for non-admins when account
  // creation is restricted — admins are exempt from the gate (see
  // isAccountCreationRestricted()/KORTIX_RESTRICT_ACCOUNT_CREATION). The
  // backend 403 (account_creation_restricted) is the authoritative gate;
  // this only avoids showing an affordance a non-admin can't use.
  const canCreateAccount = !isAccountCreationRestricted() || Boolean(adminRole?.isAdmin);

  useSignedOutRedirect();

  const accountsQuery = useAccountsList();
  // The exact key `accountsQuery` reads, for the create-account seed below.
  const accountsQueryKey = useAccountsQueryKey();

  const sortedAccounts = useMemo(() => {
    const accounts = accountsQuery.data ?? [];
    return [...accounts].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }, [accountsQuery.data]);

  if (authLoading || !user) {
    return <ConnectingScreen forceConnecting overrideStage="auth" hideWorkspacePicker />;
  }

  return (
    <>
      <div className="mx-auto w-full max-w-6xl space-y-5 pb-10">
        <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <h2 className="text-foreground text-xl font-medium">Accounts</h2>
            <p className="text-muted-foreground text-sm text-balance">Teams you belong to.</p>
          </div>
          {canCreateAccount && (
            <div className="mt-2 shrink-0 sm:mt-0">
              <Button
                size="sm"
                variant="secondary"
                className="gap-1.5"
                onClick={() => setCreateOpen(true)}
              >
                <Plus className="size-4" />
                New account
              </Button>
            </div>
          )}
        </header>

        {accountsQuery.isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-[54px] w-full rounded-md" />
            ))}
          </div>
        ) : accountsQuery.isError ? (
          <ErrorState
            size="sm"
            title="Failed to load accounts"
            description={(accountsQuery.error as Error).message}
            action={
              <Button variant="outline" size="sm" onClick={() => accountsQuery.refetch()}>
                Retry
              </Button>
            }
          />
        ) : sortedAccounts.length === 0 ? (
          <EmptyState
            icon={Users}
            size="sm"
            title="No accounts yet"
            description="Create an account to start working with a team."
            action={
              canCreateAccount ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => setCreateOpen(true)}
                >
                  <Plus className="size-3.5" />
                  New account
                </Button>
              ) : undefined
            }
          />
        ) : (
          <ul className="space-y-2">
            {sortedAccounts.map((account) => (
              <AccountRow
                key={account.account_id}
                account={account}
                active={account.account_id === selectedAccountId}
              />
            ))}
          </ul>
        )}
      </div>

      <CreateAccountModal
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(account) => {
          // The reader's OWN key, not a hand-built one: writer and reader
          // on different keys is silent — the create appears to succeed and
          // the list never changes.
          queryClient.setQueryData<KortixAccount[]>(accountsQueryKey, (accounts) => {
            const current = accounts ?? [];
            return current.some((item) => item.account_id === account.account_id)
              ? current.map((item) => (item.account_id === account.account_id ? account : item))
              : [account, ...current];
          });
          // `scope()`, not `list(userId)`: this is the "the account list
          // changed" prefix, and it provably reaches the only slot that can
          // be live without a callback having to re-derive whose slot it is.
          void queryClient.invalidateQueries({ queryKey: qk.accounts.scope() });
          setSelectedAccountId(account.account_id);
          // qk.projects.scope(): reaches every account's list (and the
          // accountless slot), the same reach the old bare projects-literal
          // prefix match had. Account creation is rare — over-invalidating
          // costs nothing measurable.
          void queryClient.invalidateQueries({
            queryKey: qk.projects.scope(),
          });
          // The landing door, NOT the remembered project: that cookie names a
          // project in the account being left.
          router.replace(PROJECT_LANDING_PATH);
        }}
      />
    </>
  );
}

function AccountRow({ account, active }: { account: KortixAccount; active: boolean }) {
  const label = account.name || 'Account';
  return (
    <li>
      {/* The account hub is a render-time destination, so the row is an anchor.
          A button would run the RSC fetch cold on every click. */}
      <Link
        href={`/accounts/${account.account_id}`}
        className="group bg-popover hover:bg-accent flex w-full cursor-pointer items-center gap-3 rounded-md border px-4 py-2.5 text-left transition-colors"
      >
        <EntityAvatar label={label} size="md" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="text-foreground truncate text-sm font-medium">{label}</span>
            {active && (
              <Badge variant="outline" size="sm" className="border-foreground/30 text-foreground">
                Active
              </Badge>
            )}
          </span>
          {account.account_role ? (
            <span className="text-muted-foreground block text-xs capitalize">
              {account.account_role}
            </span>
          ) : null}
        </span>
        <ChevronRight className="text-muted-foreground size-4 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
      </Link>
    </li>
  );
}

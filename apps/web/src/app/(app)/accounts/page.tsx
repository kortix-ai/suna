'use client';

import { ConnectingScreen } from '@/components/dashboard/connecting-screen';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { CreateAccountModal } from '@/features/accounts/create-account-modal';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { useAuth } from '@/features/providers/auth-provider';
import { useCurrentAccountStore } from '@/stores/current-account-store';
import { listAccounts, type KortixAccount } from '@kortix/sdk/projects-client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Plus, Users } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

export default function AccountsPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user, isLoading: authLoading } = useAuth();
  const { selectedAccountId, setSelectedAccountId } = useCurrentAccountStore();
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    if (!authLoading && !user) router.replace('/auth');
  }, [authLoading, user, router]);

  const accountsQuery = useQuery({
    queryKey: ['accounts'],
    queryFn: listAccounts,
    enabled: !!user,
    staleTime: 60_000,
  });

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
          <div className="mt-2 shrink-0 sm:mt-0">
            <Button size="sm" variant="secondary" className="gap-1.5" onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" />
              New account
            </Button>
          </div>
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
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setCreateOpen(true)}>
                <Plus className="size-3.5" />
                New account
              </Button>
            }
          />
        ) : (
          <ul className="space-y-2">
            {sortedAccounts.map((account) => (
              <AccountRow
                key={account.account_id}
                account={account}
                active={account.account_id === selectedAccountId}
                onClick={() => router.push(`/accounts/${account.account_id}`)}
              />
            ))}
          </ul>
        )}
      </div>

      <CreateAccountModal
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(account) => {
          queryClient.setQueryData<KortixAccount[]>(['accounts'], (accounts) => {
            const current = accounts ?? [];
            return current.some((item) => item.account_id === account.account_id)
              ? current.map((item) => (item.account_id === account.account_id ? account : item))
              : [account, ...current];
          });
          void queryClient.invalidateQueries({ queryKey: ['accounts'] });
          setSelectedAccountId(account.account_id);
          void queryClient.invalidateQueries({
            queryKey: ['projects', account.account_id],
          });
          router.replace('/projects');
        }}
      />
    </>
  );
}

function AccountRow({
  account,
  active,
  onClick,
}: {
  account: KortixAccount;
  active: boolean;
  onClick: () => void;
}) {
  const label = account.name || 'Account';
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
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
      </button>
    </li>
  );
}

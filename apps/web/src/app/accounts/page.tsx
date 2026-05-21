'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, ChevronRight, Plus } from 'lucide-react';
import { useAuth } from '@/components/AuthProvider';
import { ConnectingScreen } from '@/components/dashboard/connecting-screen';
import { AppHeader } from '@/components/layout/app-header';
import { CreateAccountModal } from '@/components/accounts/create-account-modal';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import { List, ListRow } from '@/components/ui/list';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';
import { listAccounts, type KortixAccount } from '@/lib/projects-client';
import { useCurrentAccountStore } from '@/stores/current-account-store';

export default function AccountsPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user, isLoading: authLoading } = useAuth();
  const { selectedAccountId } = useCurrentAccountStore();
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

  // Personal first, then alpha. One flat list — the distinction is just a badge.
  const sortedAccounts = useMemo(
    () => {
      const accounts = accountsQuery.data ?? [];
      return [...accounts].sort((a, b) => {
        if (a.personal_account && !b.personal_account) return -1;
        if (!a.personal_account && b.personal_account) return 1;
        return (a.name || '').localeCompare(b.name || '');
      });
    },
    [accountsQuery.data],
  );

  if (authLoading || !user) {
    return <ConnectingScreen forceConnecting overrideStage="auth" hideWorkspacePicker />;
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <AppHeader user={user} />
      <main className="flex-1 px-4 py-8">
        <div className="mx-auto w-full max-w-4xl space-y-8">
          <button
            type="button"
            onClick={() => router.push('/projects')}
            className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to projects
          </button>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">Accounts</h1>
              <p className="mt-1 text-sm text-muted-foreground">Accounts you belong to.</p>
            </div>
            <Button onClick={() => setCreateOpen(true)} className="gap-1.5">
              <Plus className="h-4 w-4" />
              New account
            </Button>
          </div>

          {accountsQuery.isLoading ? (
            <SectionCard flush>
              <List>
                {Array.from({ length: 3 }).map((_, i) => (
                  <li key={i} className="flex items-center gap-3 px-6 py-3">
                    <Skeleton className="size-8 rounded-lg" />
                    <div className="flex-1 space-y-1.5">
                      <Skeleton className="h-3.5 w-40" />
                      <Skeleton className="h-3 w-20" />
                    </div>
                  </li>
                ))}
              </List>
            </SectionCard>
          ) : (
            <SectionCard flush>
              <List>
                {sortedAccounts.map((account) => (
                  <AccountRow
                    key={account.account_id}
                    account={account}
                    active={account.account_id === selectedAccountId}
                    onClick={() => router.push(`/accounts/${account.account_id}`)}
                  />
                ))}
              </List>
            </SectionCard>
          )}
        </div>
      </main>

      <CreateAccountModal
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => {
          // Stay on /accounts and refresh the list so the new account shows up
          // immediately — no manual hard refresh, no redirect to /projects.
          queryClient.invalidateQueries({ queryKey: ['accounts'] });
        }}
      />
    </div>
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
  const label = account.name || (account.personal_account ? 'Personal' : 'Account');
  return (
    <ListRow
      onClick={onClick}
      leading={<EntityAvatar label={label} />}
      title={label}
      badges={
        <>
          {account.personal_account && (
            <Badge variant="outline" size="sm">
              Personal
            </Badge>
          )}
          {active && (
            <Badge variant="outline" size="sm">
              <Check />
              Active
            </Badge>
          )}
        </>
      }
      subtitle={
        <span className="text-xs capitalize text-muted-foreground">
          {account.account_role || 'owner'}
        </span>
      }
      trailing={
        <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
      }
    />
  );
}

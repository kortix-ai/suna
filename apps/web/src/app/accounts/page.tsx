'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Check, ChevronRight, Plus } from 'lucide-react';
import { useAuth } from '@/components/AuthProvider';
import { ConnectingScreen } from '@/components/dashboard/connecting-screen';
import { AppHeader } from '@/components/layout/app-header';
import { CreateAccountModal } from '@/components/accounts/create-account-modal';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { listAccounts, type KortixAccount } from '@/lib/projects-client';
import { useCurrentAccountStore } from '@/stores/current-account-store';
import { cn } from '@/lib/utils';

export default function AccountsPage() {
  const router = useRouter();
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
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to projects
          </button>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">Accounts</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Accounts you belong to.
              </p>
            </div>
            <Button onClick={() => setCreateOpen(true)} className="gap-1.5">
              <Plus className="h-4 w-4" />
              New account
            </Button>
          </div>

          {accountsQuery.isLoading && (
            <div className="space-y-3">
              <Skeleton className="h-16 rounded-xl" />
              <Skeleton className="h-16 rounded-xl" />
            </div>
          )}

          {!accountsQuery.isLoading && sortedAccounts.length > 0 && (
            <div className="space-y-2">
              {sortedAccounts.map((account) => (
                <AccountRow
                  key={account.account_id}
                  account={account}
                  active={account.account_id === selectedAccountId}
                  onClick={() => {
                    setSelectedAccountId(account.account_id);
                    router.push('/projects');
                  }}
                />
              ))}
            </div>
          )}
        </div>
      </main>

      <CreateAccountModal
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(account) => {
          setSelectedAccountId(account.account_id);
          router.push('/projects');
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
  const initial = label.charAt(0).toUpperCase();
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group flex w-full items-center gap-4 rounded-xl border border-border/70 bg-card px-4 py-3 text-left transition-colors',
        'hover:border-foreground/30 hover:bg-muted/30',
      )}
    >
      <div className="flex h-9 w-9 items-center justify-center rounded-md border border-border/70 bg-background text-sm font-semibold">
        {initial}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">{label}</span>
          {account.personal_account && (
            <Badge variant="outline" className="h-4 rounded-md px-1 text-[9px] font-normal">
              Personal
            </Badge>
          )}
          {active && (
            <Badge variant="outline" className="h-4 rounded-md px-1 text-[9px] font-normal gap-0.5">
              <Check className="h-2.5 w-2.5" />
              Active
            </Badge>
          )}
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
          <span className="capitalize">{account.account_role || 'owner'}</span>
        </div>
      </div>
      <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
  );
}

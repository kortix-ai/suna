'use client';

import { useTranslations } from 'next-intl';

import { ConnectingScreen } from '@/components/dashboard/connecting-screen';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import { List, ListRow } from '@/components/ui/list';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';
import { CreateAccountModal } from '@/features/accounts/create-account-modal';
import { useAuth } from '@/features/providers/auth-provider';
import { listAccounts, type KortixAccount } from '@/lib/projects-client';
import { useCurrentAccountStore } from '@/stores/current-account-store';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronRight, Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

export default function AccountsPage() {
  const tHardcodedUi = useTranslations('hardcodedUi');
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
      <main className="flex-1 px-4 py-8">
        <div className="mx-auto w-full max-w-6xl space-y-8">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h1 className="text-foreground text-2xl font-semibold tracking-tight">Accounts</h1>
              <p className="text-muted-foreground mt-1 text-sm">
                {tHardcodedUi.raw('appAccountsPage.line71JsxTextAccountsYouBelongTo')}
              </p>
            </div>
            <Button onClick={() => setCreateOpen(true)} className="gap-1.5">
              <Plus className="h-4 w-4" />
              {tHardcodedUi.raw('appAccountsPage.line75JsxTextNewAccount')}
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
    <ListRow
      onClick={onClick}
      leading={<EntityAvatar label={label} />}
      title={label}
      badges={
        <>
          {active && (
            <Badge variant="outline" size="sm">
              <Check />
              Active
            </Badge>
          )}
        </>
      }
      trailing={
        <ChevronRight className="text-muted-foreground h-4 w-4 opacity-0 transition-opacity group-hover:opacity-100" />
      }
    />
  );
}

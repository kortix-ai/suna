'use client';

import { useQuery } from '@tanstack/react-query';
import { Archive } from 'lucide-react';

import { ConnectingScreen } from '@/components/dashboard/connecting-screen';
import { LegacyMachineCard } from '@/components/projects/legacy-machine-card';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';
import { AppHeader } from '@/features/layout/app-header';
import { EmptyState } from '@/features/layout/section/empty-state';
import { useAuth } from '@/features/providers/auth-provider';
import { useLegacyMachines } from '@/hooks/legacy/use-legacy-machine-migration';
import { listAccounts } from '@/lib/projects-client';
import { useCurrentAccountStore } from '@/stores/current-account-store';

/**
 * Hidden archive of legacy (pre-migration) machines. Not linked from the main
 * nav — reachable by direct URL or a discreet link on the Projects page.
 * Automatic migration is retired; each machine offers a "request restore" that
 * emails support. Scoped to the currently selected account, like Projects.
 */
export default function LegacyMachinesPage() {
  const { user, isLoading: authLoading } = useAuth();
  const { selectedAccountId } = useCurrentAccountStore();

  const accountsQuery = useQuery({
    queryKey: ['accounts'],
    queryFn: listAccounts,
    enabled: !!user,
    staleTime: 60_000,
  });
  const activeAccountId =
    accountsQuery.data?.find((a) => a.account_id === selectedAccountId)?.account_id ??
    accountsQuery.data?.[0]?.account_id ??
    null;

  const machinesQuery = useLegacyMachines({
    enabled: !!user && !!activeAccountId,
    accountId: activeAccountId,
  });
  const machines = machinesQuery.data?.sandboxes ?? [];

  if (authLoading || !user) {
    return <ConnectingScreen forceConnecting overrideStage="auth" hideWorkspacePicker />;
  }

  const loading = accountsQuery.isLoading || machinesQuery.isLoading;

  return (
    <div className="bg-foreground/5 flex min-h-screen flex-col">
      <AppHeader user={user} breadcrumb="Legacy machines" />
      <main className="ring-input bg-background px-mobile flex-1 rounded-t-xl py-10 ring sm:py-12">
        <div className="mx-auto w-full max-w-6xl space-y-8">
          <div className="min-w-0 space-y-1">
            <h1 className="text-foreground text-2xl font-semibold tracking-tight sm:text-3xl">
              Legacy machines
            </h1>
            <p className="text-muted-foreground text-base">
              Older machines from before the current platform. They&rsquo;re archived and can be
              restored on request — contact support and we&rsquo;ll bring one back.
            </p>
          </div>

          {loading && (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {['a', 'b', 'c'].map((k) => (
                <Skeleton key={k} className="h-[132px] rounded-2xl" />
              ))}
            </div>
          )}

          {!loading && machines.length === 0 && (
            <SectionCard flush>
              <EmptyState
                icon={Archive}
                title="No legacy machines"
                description="You don't have any archived machines to restore."
              />
            </SectionCard>
          )}

          {!loading && machines.length > 0 && (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {machines.map((machine) => (
                <LegacyMachineCard key={machine.sandbox_id} machine={machine} />
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

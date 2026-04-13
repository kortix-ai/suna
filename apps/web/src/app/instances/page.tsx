'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Loader2, Plus } from 'lucide-react';
import { toast as sonnerToast } from 'sonner';

import { ConnectingScreen } from '@/components/dashboard/connecting-screen';
import {
  listSandboxes,
  ensureSandbox,
  restartSandbox,
  type SandboxInfo,
} from '@/lib/platform-client';
import { isBillingEnabled } from '@/lib/config';
import { useServerStore, type ServerEntry } from '@/stores/server-store';
import { useAccountState } from '@/hooks/billing/use-account-state';
import { claimComputer } from '@/lib/api/billing';

import { NewInstanceModal } from '@/components/billing/pricing/new-instance-modal';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  ComputerHeroCard,
  InstancesTopBar,
} from './_components/shared';
import {
  FallbackInstanceCard,
  InstanceCard,
} from './_components/instance-card';
import { InstanceUpdateDialog } from './_components/instance-update-dialog';

// ─── Main Page ──────────────────────────────────────────────────────────────

export default function InstancesPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user, isLoading: authLoading } = useAuth();
  const { servers, activeServerId } = useServerStore();
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [autoCreating, setAutoCreating] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [updateTarget, setUpdateTarget] = useState<SandboxInfo | null>(null);
  const [restartTarget, setRestartTarget] = useState<SandboxInfo | null>(null);
  const isCloud = isBillingEnabled();
  const {
    data: accountState,
    isLoading: accountStateLoading,
    refetch: refetchAccountState,
  } = useAccountState();

  // Redirect to auth if not logged in
  useEffect(() => {
    if (!authLoading && !user) {
      router.replace('/auth');
    }
  }, [authLoading, user, router]);

  const { data: sandboxes, isLoading, error, refetch } = useQuery({
    queryKey: ['platform', 'sandbox', 'list'],
    queryFn: listSandboxes,
    enabled: !!user,
    refetchInterval: (query) => {
      // Poll every 15s if any sandbox is provisioning (real-time updates happen on the detail page via SSE)
      const data = query.state.data;
      if (data?.some((s) => s.status === 'provisioning')) return 15_000;
      return 60_000; // 60s when all stable
    },
  });

  // After Stripe checkout redirect — just clean the URL and refetch.
  // The webhook already created the subscription + provisioned the sandbox.
  useEffect(() => {
    if (!user) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('subscription') !== 'success') return;
    const clean = new URL(window.location.href);
    clean.searchParams.delete('subscription');
    clean.searchParams.delete('session_id');
    window.history.replaceState({}, '', clean.pathname);
    refetch();
  }, [user, refetch]);

  // Local mode: auto-create the single sandbox if none exists, then redirect.
  // Only 1 instance allowed in local mode.
  useEffect(() => {
    if (!user || isLoading || autoCreating || isCloud) return;
    if (sandboxes && sandboxes.length === 0) {
      setAutoCreating(true);
      ensureSandbox()
        .then(() => refetch())
        .catch(() => { })
        .finally(() => setAutoCreating(false));
    }
  }, [user, isLoading, sandboxes, autoCreating, isCloud, refetch]);

  // Auto-redirect: if there's exactly 1 instance (local mode typical), go straight to it.
  useEffect(() => {
    if (isLoading || !sandboxes) return;
    const active = sandboxes.filter((s) => s.status !== 'archived');
    if (active.length === 1 && !isCloud) {
      router.replace(`/instances/${active[0].sandbox_id}`);
    }
  }, [isLoading, sandboxes, isCloud, router]);

  // Filter out archived — user shouldn't see those
  const visible = sandboxes?.filter((s) => s.status !== 'archived') ?? [];
  const fallbackServers = servers.filter((s) => !!s.provider || !!s.url);

  // ── Per-card action handlers ──
  //
  // Each of these runs against a *specific* sandbox_id rather than the
  // user's currently active one, so a user with multiple instances can
  // restart / update / inspect backups on any card without first
  // switching the app over to it.

  const restartMutation = useMutation({
    mutationFn: (sandboxId: string) => restartSandbox(sandboxId),
    onMutate: (sandboxId) => {
      sonnerToast.loading('Restarting instance…', { id: `restart-${sandboxId}` });
    },
    onSuccess: (_data, sandboxId) => {
      sonnerToast.success('Instance restarted', { id: `restart-${sandboxId}` });
      setRestartTarget(null);
      // Refresh the list so the status pill + version reflect reality.
      queryClient.invalidateQueries({ queryKey: ['platform', 'sandbox', 'list'] });
    },
    onError: (error, sandboxId) => {
      const msg = error instanceof Error ? error.message : 'Failed to restart instance';
      sonnerToast.error(msg, { id: `restart-${sandboxId}` });
      setRestartTarget(null);
    },
  });

  function handleRestart(sandbox: SandboxInfo) {
    // Opening the card's restart action shows a confirmation dialog —
    // the mutation fires only after the user confirms in
    // <ConfirmDialog /> below.
    if (restartMutation.isPending) return;
    setRestartTarget(sandbox);
  }

  function confirmRestart() {
    if (!restartTarget || restartMutation.isPending) return;
    restartMutation.mutate(restartTarget.sandbox_id);
  }

  function handleChangelog(sandbox: SandboxInfo) {
    setUpdateTarget(sandbox);
  }

  function handleBackups(sandbox: SandboxInfo) {
    router.push(`/instances/${sandbox.sandbox_id}/backups`);
  }

  function handleInstanceClick(sandbox: SandboxInfo) {
    // Active sandboxes go directly to the dashboard — skipping the
    // `/instances/[id]` gatekeeper eliminates a route boundary and a
    // remount of the connecting screen. For any non-active status the
    // gatekeeper handles the UI (provisioning, error, stopped).
    if (sandbox.status === 'active') {
      router.push(`/instances/${sandbox.sandbox_id}/dashboard`);
      return;
    }
    router.push(`/instances/${sandbox.sandbox_id}`);
  }

  function handleFallbackServerClick(server: ServerEntry) {
    if (server.instanceId) {
      // Fallback servers are assumed to already be warm.
      router.push(`/instances/${server.instanceId}/dashboard`);
    } else {
      router.push('/dashboard');
    }
  }

  function handleCreateInstance() {
    if (isCloud) {
      setCheckoutOpen(true);
    } else {
      // Local mode: create directly, no checkout
      setAutoCreating(true);
      ensureSandbox()
        .then(() => refetch())
        .catch(() => { })
        .finally(() => setAutoCreating(false));
    }
  }

  const handleClaimComputer = async () => {
    try {
      setClaiming(true);
      const result = await claimComputer();
      refetch();
      refetchAccountState();
      if (result?.data?.sandbox_id) {
        router.push(`/instances/${result.data.sandbox_id}`);
      }
    } catch {
      // Error handled by API client
    } finally {
      setClaiming(false);
    }
  };

  const canClaimComputer = accountState?.can_claim_computer === true;
  const pageLoading = isLoading || (isCloud && accountStateLoading);

  // Single canonical loader until auth + initial sandbox list are ready.
  // Prevents showing the page shell with an inline spinner.
  if (authLoading || !user) {
    return <ConnectingScreen forceConnecting overrideStage="auth" />;
  }
  if (pageLoading && (sandboxes === undefined || sandboxes.length === 0)) {
    return <ConnectingScreen forceConnecting overrideStage="routing" />;
  }

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <InstancesTopBar user={user} />

      <main className="flex-1 flex items-start justify-center px-4 pt-12 pb-20">
        <div className="w-full max-w-lg">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-baseline gap-2.5">
              <h1 className="text-xl font-semibold text-foreground">Instances</h1>
              {visible.length > 0 && (
                <span className="text-xs font-medium text-muted-foreground tabular-nums">
                  {visible.length}
                </span>
              )}
            </div>
            {isCloud && visible.length > 0 && (
              <Button
                size="sm"
                onClick={handleCreateInstance}
                disabled={autoCreating}
                className="gap-1.5"
              >
                {autoCreating ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Plus className="h-3.5 w-3.5" />
                )}
                {autoCreating ? 'Creating…' : 'New Instance'}
              </Button>
            )}
          </div>

          {/* Error */}
          {error && !pageLoading && fallbackServers.length === 0 && (
            <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 flex items-center gap-3">
              <AlertCircle className="h-5 w-5 text-destructive flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm text-destructive font-medium">Failed to load instances</p>
                <p className="text-xs text-destructive/70 mt-0.5">{(error as Error).message}</p>
              </div>
              <Button variant="outline" size="sm" onClick={() => refetch()}>
                Retry
              </Button>
            </div>
          )}

          {/* Claim computer card for legacy paid users */}
          {canClaimComputer && !pageLoading && (
            <ComputerHeroCard
              title="Kortix is now even better"
              description={
                <>
                  Your plan now includes a dedicated cloud computer
                  {accountState?.tier?.monthly_credits ? (
                    <>
                      {' '}with{' '}
                      <span className="text-foreground font-medium">
                        ${accountState.tier.monthly_credits}/mo
                      </span>{' '}
                      in credits
                    </>
                  ) : ''}
                  . Always on, runs while you sleep, full root access.
                </>
              }
              ctaLabel="Claim Computer"
              ctaLoadingLabel="Setting up…"
              onCta={handleClaimComputer}
              loading={claiming}
              features={['Included in your plan', 'Always on', 'Persistent storage']}
            />
          )}

          {/* Get your computer card for users with no instances (non-legacy) */}
          {!pageLoading && !error && visible.length === 0 && fallbackServers.length === 0 && !canClaimComputer && (
            <ComputerHeroCard
              title="Get Your Cloud Computer"
              description="A dedicated cloud computer that's always on, runs while you sleep, with full root access and persistent storage."
              ctaLabel="Get Started"
              ctaLoadingLabel="Setting up…"
              onCta={handleCreateInstance}
              loading={autoCreating}
              features={['Always on', 'Full root access', 'Persistent storage']}
            />
          )}

          {/* Instance list */}
          {!pageLoading && visible.length > 0 && (
            <div className="flex flex-col gap-2">
              {visible.map((sandbox) => {
                const isRestarting =
                  restartMutation.isPending && restartMutation.variables === sandbox.sandbox_id;
                return (
                  <InstanceCard
                    key={sandbox.sandbox_id}
                    sandbox={sandbox}
                    onClick={() => handleInstanceClick(sandbox)}
                    onRestart={() => handleRestart(sandbox)}
                    onChangelog={() => handleChangelog(sandbox)}
                    onBackups={() => handleBackups(sandbox)}
                    restarting={isRestarting}
                  />
                );
              })}
            </div>
          )}

          {/* Fallback list from server store when sandbox API list is unavailable */}
          {!pageLoading && visible.length === 0 && fallbackServers.length > 0 && (
            <div className="flex flex-col gap-2">
              {fallbackServers.map((server) => (
                <FallbackInstanceCard
                  key={server.id}
                  server={server}
                  isActive={server.id === activeServerId}
                  onClick={() => handleFallbackServerClick(server)}
                />
              ))}
            </div>
          )}
        </div>
      </main>

      {/* Checkout modal — opens instantly, no page navigation */}
      <NewInstanceModal open={checkoutOpen} onOpenChange={setCheckoutOpen} />

      {/* Restart confirmation — destructive enough to warrant an
          explicit prompt (it tears down the running machine). */}
      <ConfirmDialog
        open={!!restartTarget}
        onOpenChange={(open) => {
          if (!open && !restartMutation.isPending) setRestartTarget(null);
        }}
        title="Restart this instance?"
        description={
          <>
            This will stop and start{' '}
            <span className="font-medium text-foreground">
              {restartTarget?.name || restartTarget?.sandbox_id || 'the instance'}
            </span>
            . Any unsaved in-memory state will be lost, but files on the
            persistent volume are safe.
          </>
        }
        confirmLabel="Restart"
        onConfirm={confirmRestart}
        isPending={restartMutation.isPending}
      />

      {/* Per-instance update dialog — targets a specific sandbox so it
          works even when the user isn't connected to that instance. */}
      <InstanceUpdateDialog
        sandbox={updateTarget}
        open={!!updateTarget}
        onClose={() => setUpdateTarget(null)}
        onCompleted={() => {
          queryClient.invalidateQueries({ queryKey: ['platform', 'sandbox', 'list'] });
        }}
      />
    </div>
  );
}

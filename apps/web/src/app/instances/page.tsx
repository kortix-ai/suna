'use client';

/**
 * Workspace picker — the dedicated "choose your workspace" page.
 *
 * Modeled after Slack's workspace switcher: a clean grid of all the user's
 * instances, an account menu for log-out, and a "Create workspace" CTA.
 *
 * This page is REACHABLE FROM:
 * - The sidebar workspace switcher's "All workspaces" link
 * - The connecting screen's persistent "Choose workspace" link (top-right)
 * - Direct navigation to /instances
 *
 * Post-auth still lands users on /dashboard (their last-used instance) for
 * speed; this page is for explicit picking, not the default landing.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Plus } from 'lucide-react';

import { ConnectingScreen } from '@/components/dashboard/connecting-screen';
import {
  ensureSandbox,
  listSandboxes,
  type SandboxInfo,
} from '@/lib/platform-client';
import { isBillingEnabled } from '@/lib/config';
import {
  activateInstanceSelection,
  activateServerSelection,
  useServerStore,
  type ServerEntry,
} from '@/stores/server-store';
import { useAccountState } from '@/hooks/billing/use-account-state';
import { claimComputer } from '@/lib/api/billing';
import { useNewInstanceModalStore } from '@/stores/pricing-modal-store';
import { NewInstanceModal } from '@/components/billing/pricing/new-instance-modal';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  ComputerHeroCard,
  InstancesTopBar,
} from './_components/shared';
import {
  FallbackInstanceCard,
  InstanceCard,
} from './_components/instance-card';
import { InstanceSettingsModal } from './_components/instance-settings-modal';

export default function InstancesPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user, isLoading: authLoading } = useAuth();
  const { servers, activeServerId } = useServerStore();
  const [claiming, setClaiming] = useState(false);
  const [creatingLocal, setCreatingLocal] = useState(false);
  const [settingsTarget, setSettingsTarget] = useState<SandboxInfo | null>(null);
  const isCloud = isBillingEnabled();
  // Local state — the global NewInstanceModal lives in AppProviders, which
  // only wraps the (dashboard) route group. /instances is outside that
  // group so the global instance is never mounted; we mount one locally
  // here instead. Keeping it state-driven (not store-driven) avoids the
  // dead-click bug where openNewInstanceModal() flips a store flag with
  // no listener mounted.
  const [showNewInstanceModal, setShowNewInstanceModal] = useState(false);
  // Kept for parity in case any other component opens it via the store
  // and we land here mid-flow.
  const isStoreModalOpen = useNewInstanceModalStore((s) => s.isOpen);
  const closeStoreModal = useNewInstanceModalStore((s) => s.closeNewInstanceModal);

  const {
    data: accountState,
    refetch: refetchAccountState,
  } = useAccountState({ enabled: !!user && isCloud });

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
      const data = query.state.data;
      if (data?.some((s) => s.status === 'provisioning')) return 15_000;
      return 60_000;
    },
  });

  // Stripe checkout return — clear the query, refetch.
  useEffect(() => {
    if (!user) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('subscription') !== 'success') return;
    const clean = new URL(window.location.href);
    clean.searchParams.delete('subscription');
    clean.searchParams.delete('session_id');
    window.history.replaceState({}, '', clean.pathname);
    queryClient.invalidateQueries({ queryKey: ['platform', 'sandbox'] });
  }, [user, queryClient]);

  const visible = sandboxes?.filter((s) => s.status !== 'archived') ?? [];
  const fallbackServers = servers.filter((s) => !!s.provider || !!s.url);

  function handleOpenSettings(sandbox: SandboxInfo) {
    setSettingsTarget(sandbox);
  }

  async function handleInstanceClick(sandbox: SandboxInfo) {
    if (sandbox.status === 'active') {
      const result = await activateInstanceSelection(sandbox.sandbox_id, {
        pathname: '/instances',
      });
      router.push(result?.href ?? `/instances/${sandbox.sandbox_id}/dashboard`);
      return;
    }
    router.push(`/instances/${sandbox.sandbox_id}`);
  }

  function handleFallbackServerClick(server: ServerEntry) {
    const result = activateServerSelection(server.id, { pathname: '/instances' });
    if (server.instanceId) {
      router.push(result?.href ?? `/instances/${server.instanceId}/dashboard`);
      return;
    }
    router.push(result?.href ?? '/dashboard');
  }

  async function handleCreateInstance() {
    if (isCloud) {
      setShowNewInstanceModal(true);
      return;
    }
    setCreatingLocal(true);
    try {
      await ensureSandbox();
      await refetch();
    } finally {
      setCreatingLocal(false);
    }
  }

  const handleClaimComputer = async () => {
    setClaiming(true);
    try {
      const result = await claimComputer();
      await refetch();
      await refetchAccountState();
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

  if (authLoading || !user) {
    return <ConnectingScreen forceConnecting overrideStage="auth" hideWorkspacePicker />;
  }
  if (isLoading && !sandboxes) {
    return <ConnectingScreen forceConnecting overrideStage="routing" hideWorkspacePicker />;
  }

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <InstancesTopBar user={user} />

      <main className="flex-1 flex items-start justify-center px-4 pt-12 pb-20">
        <div className={cn('w-full max-w-lg')}>
          {/* Header */}
          <div className="flex items-end justify-between mb-6">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">
                Choose a workspace
              </h1>
              <p className="text-sm text-muted-foreground mt-1">
                {visible.length === 0
                  ? 'Create your first workspace to get started.'
                  : `${visible.length} workspace${visible.length === 1 ? '' : 's'} · pick one to enter.`}
              </p>
            </div>
            {visible.length > 0 && (
              <Button
                size="sm"
                variant="outline"
                onClick={handleCreateInstance}
                disabled={creatingLocal}
                className="gap-1.5"
              >
                {creatingLocal ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Plus className="h-3.5 w-3.5" />
                )}
                {creatingLocal ? 'Creating…' : 'New workspace'}
              </Button>
            )}
          </div>

          {/* Error */}
          {error && fallbackServers.length === 0 && (
            <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 mb-4">
              <p className="text-sm text-destructive font-medium">Failed to load workspaces</p>
              <p className="text-xs text-destructive/70 mt-0.5">{(error as Error).message}</p>
              <Button variant="outline" size="sm" onClick={() => refetch()} className="mt-2">
                Retry
              </Button>
            </div>
          )}

          {/* Claim card for legacy paid users */}
          {canClaimComputer && (
            <div className="mb-4">
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
            </div>
          )}

          {/* Empty — no instances + no fallback */}
          {visible.length === 0 && fallbackServers.length === 0 && !canClaimComputer && (
            <ComputerHeroCard
              title="Get your cloud computer"
              description="A dedicated cloud computer that's always on, runs while you sleep, with full root access and persistent storage."
              ctaLabel="Get started"
              ctaLoadingLabel="Setting up…"
              onCta={handleCreateInstance}
              loading={creatingLocal}
              features={['Always on', 'Full root access', 'Persistent storage']}
            />
          )}

          {/* Workspace list */}
          {visible.length > 0 && (
            <div className="flex flex-col gap-2">
              {visible.map((sandbox) => (
                <InstanceCard
                  key={sandbox.sandbox_id}
                  sandbox={sandbox}
                  onClick={() => handleInstanceClick(sandbox)}
                  onSettings={() => handleOpenSettings(sandbox)}
                />
              ))}
            </div>
          )}

          {/* Fallback list */}
          {visible.length === 0 && fallbackServers.length > 0 && (
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

      <InstanceSettingsModal
        sandbox={settingsTarget}
        open={!!settingsTarget}
        onOpenChange={(open) => {
          if (!open) setSettingsTarget(null);
        }}
      />

      {/* Local mount of NewInstanceModal — the global one in AppProviders
          isn't reachable from this route. Listens to both the local state
          (clicked via this page) AND the store flag (clicked via something
          that bounced us here mid-flow). */}
      <NewInstanceModal
        open={showNewInstanceModal || isStoreModalOpen}
        onOpenChange={(o) => {
          if (!o) {
            setShowNewInstanceModal(false);
            closeStoreModal();
          }
        }}
      />
    </div>
  );
}

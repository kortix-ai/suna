'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';

import { useAuth } from '@/components/AuthProvider';
import { ConnectingScreen } from '@/components/dashboard/connecting-screen';
import { authenticatedFetch } from '@/lib/auth-token';
import { getEnv } from '@/lib/env-config';
import { buildInstancePath } from '@/lib/instance-routes';
import { getSandboxById } from '@/lib/platform-client';
import { markProvisioningVerified } from '@/stores/sandbox-connection-store';
import { switchToInstanceAsync } from '@/stores/server-store';
import { useSandboxPoller } from '@/hooks/platform/use-sandbox-poller';

/**
 * /instances/[id] — thin gatekeeper.
 *
 * This page exists only to bridge the sandbox lifecycle into the dashboard.
 * It renders the single canonical `ConnectingScreen` for every transitional
 * state (loading, provisioning, active/redirecting, error, stopped) — there
 * are no bespoke loader sub-views here and no flash between intermediate UIs.
 *
 * For `active` sandboxes it verifies health in the background and then
 * redirects to the dashboard; the dashboard's own `ConnectingScreen` gate
 * takes over seamlessly (same component, same visuals — no second loader).
 */
export default function InstanceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { user, isLoading: authLoading } = useAuth();

  useEffect(() => {
    if (!authLoading && !user) router.replace('/auth');
  }, [authLoading, user, router]);

  const { data: sandbox, isLoading, refetch } = useQuery({
    queryKey: ['platform', 'sandbox', 'detail', id],
    queryFn: () => getSandboxById(id!),
    enabled: !!user && !!id,
    staleTime: 0,
    refetchInterval: (query) =>
      query.state.data?.status === 'provisioning' ? 5_000 : false,
  });

  // Cloud provisioning poller (SSE stream from backend).
  const isLocalDocker = sandbox?.provider === 'local_docker';
  const poller = useSandboxPoller({
    sandboxId: isLocalDocker ? undefined : id,
  });

  // Local docker pull progress
  const [localProgress, setLocalProgress] = useState<{
    progress: number;
    message: string;
  } | null>(null);
  const localPollingRef = useRef(false);

  // Kick cloud poller on provisioning transition
  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (!sandbox || autoStartedRef.current || isLocalDocker) return;
    if (sandbox.status === 'provisioning') {
      autoStartedRef.current = true;
      const knownStage = (sandbox.metadata as Record<string, unknown> | null)
        ?.provisioningStage as string | undefined;
      if (knownStage) poller.seedStage?.(knownStage);
      poller.poll();
    }
  }, [sandbox, poller, isLocalDocker]);

  // When the poller says ready, refetch to flip state to active.
  useEffect(() => {
    if (poller.status === 'ready') refetch();
  }, [poller.status, refetch]);

  // Local docker: poll init status endpoint for progress/message.
  useEffect(() => {
    if (!sandbox || !isLocalDocker || sandbox.status !== 'provisioning') return;
    if (localPollingRef.current) return;
    localPollingRef.current = true;
    let stopped = false;
    const backendUrl = getEnv().BACKEND_URL || 'http://localhost:8008/v1';

    const poll = async () => {
      if (stopped) return;
      try {
        const res = await authenticatedFetch(
          `${backendUrl}/platform/init/local/status`,
        );
        const data = await res.json();
        if (data.status === 'ready') {
          setLocalProgress({ progress: 100, message: 'Ready' });
          localPollingRef.current = false;
          refetch();
          return;
        }
        if (data.status === 'error') {
          setLocalProgress(null);
          localPollingRef.current = false;
          refetch();
          return;
        }
        setLocalProgress({
          progress: data.progress || 0,
          message:
            data.status === 'creating'
              ? 'Creating container…'
              : data.message || 'Pulling sandbox image…',
        });
        if (!stopped) setTimeout(poll, 2000);
      } catch {
        if (!stopped) setTimeout(poll, 3000);
      }
    };

    poll();
    return () => {
      stopped = true;
      localPollingRef.current = false;
    };
  }, [sandbox, isLocalDocker, refetch]);

  // Active sandbox: redirect IMMEDIATELY to the dashboard. The dashboard's
  // own ConnectingScreen (same component, same visuals) handles the health
  // check. We do NOT do an extra prewarm here because it adds latency and
  // makes the user wait on THIS page before the dashboard even mounts.
  const redirectedRef = useRef(false);
  useEffect(() => {
    if (!sandbox) return;
    if (sandbox.status !== 'active') return;
    if (redirectedRef.current) return;
    redirectedRef.current = true;
    (async () => {
      markProvisioningVerified();
      await switchToInstanceAsync(sandbox.sandbox_id);
      router.replace(buildInstancePath(sandbox.sandbox_id, '/dashboard'));
    })();
  }, [sandbox, router]);

  // ── Render a single ConnectingScreen for every possible state ──────────

  // Auth / sandbox fetch in flight
  if (authLoading || !user || isLoading || !sandbox) {
    return <ConnectingScreen forceConnecting overrideStage="routing" />;
  }

  // Provisioning — use determinate progress from the appropriate poller
  if (sandbox.status === 'provisioning') {
    const label = sandbox.name || 'workspace';
    const progressPct = isLocalDocker
      ? localProgress?.progress ?? 0
      : poller.progress ?? 0;
    const stageLabel = isLocalDocker
      ? localProgress?.message
      : undefined;
    return (
      <ConnectingScreen
        provisioning={{
          progress: progressPct,
          stageLabel,
          stages: isLocalDocker ? null : poller.stages,
          currentStage: isLocalDocker ? null : poller.currentStage,
          machineInfo: isLocalDocker ? null : poller.machineInfo,
        }}
        labelOverride={label}
        title="Provisioning workspace"
      />
    );
  }

  // Error
  if (sandbox.status === 'error') {
    const meta = (sandbox.metadata as Record<string, unknown>) ?? {};
    return (
      <ConnectingScreen
        error={{
          message:
            poller.error ||
            (meta.provisioningError as string) ||
            'Something went wrong while provisioning this workspace.',
          serverType: meta.serverType as string | undefined,
          location: meta.location as string | undefined,
        }}
        labelOverride={sandbox.name || 'workspace'}
      />
    );
  }

  // Stopped
  if (sandbox.status === 'stopped') {
    return (
      <ConnectingScreen
        stopped={{ name: sandbox.name || 'workspace' }}
      />
    );
  }

  // Active (redirecting) — single shared screen until the dashboard mounts.
  return (
    <ConnectingScreen
      forceConnecting
      overrideStage="reaching"
      labelOverride={sandbox.name || 'workspace'}
    />
  );
}


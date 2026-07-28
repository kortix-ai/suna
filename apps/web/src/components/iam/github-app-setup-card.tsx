'use client';

import Nango, { type ConnectUIEvent } from '@nangohq/frontend';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Github, Link2, RefreshCw, RotateCcw, Unplug } from 'lucide-react';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import Loading from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import {
  type ManagedGitHubCandidate,
  type ManagedGitHubConnectSession,
  createManagedGitHubConnectSession,
  createManagedGitHubReconnectSession,
  disconnectManagedGitHubConnection,
  getManagedGitHubStatus,
  listManagedGitHubCandidates,
  selectManagedGitHubCandidate,
} from '@kortix/sdk';

const GITHUB_APP_STATUS_KEY = ['managed-github-status'];
const GITHUB_CANDIDATES_KEY = ['managed-github-candidates'];

const REQUIRED_MANAGED_GITHUB_PERMISSIONS = [
  { key: 'administration', label: 'Administration: read and write', level: 'write' },
  { key: 'contents', label: 'Contents: read and write', level: 'write' },
  { key: 'metadata', label: 'Metadata: read', level: 'read' },
  { key: 'pull_requests', label: 'Pull requests: read and write', level: 'write' },
] as const;

function missingManagedGitHubPermissions(candidate: ManagedGitHubCandidate): string[] {
  if (Object.keys(candidate.permissions).length === 0) return [];
  return REQUIRED_MANAGED_GITHUB_PERMISSIONS.flatMap(({ key, label, level }) => {
    const actual = candidate.permissions[key];
    const allowed = actual === 'write' || (level === 'read' && actual === 'read');
    return allowed ? [] : [label];
  });
}

function useGitHubAppStatus(enabled = true) {
  return useQuery({
    queryKey: GITHUB_APP_STATUS_KEY,
    queryFn: () => getManagedGitHubStatus(),
    staleTime: 10_000,
    enabled,
  });
}

function connectEventError(event: Extract<ConnectUIEvent, { type: 'error' }>): Error {
  return new Error(event.payload.errorMessage || 'GitHub authorization failed.');
}

function openConnectUi(session: ManagedGitHubConnectSession): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let connectUi: { close(): void } | null = null;

    const finish = (result: string | null, error?: Error) => {
      if (settled) return;
      settled = true;
      connectUi?.close();
      if (error) reject(error);
      else resolve(result);
    };

    try {
      const nango = new Nango({ connectSessionToken: session.token });
      connectUi = nango.openConnectUI({
        detectClosedAuthWindow: true,
        onEvent: (event) => {
          if (event.type === 'connect') {
            finish(event.payload.connectionId);
            return;
          }
          if (event.type === 'error') {
            finish(null, connectEventError(event));
            return;
          }
          if (event.type === 'close') finish(null);
        },
      });
    } catch (error) {
      finish(
        null,
        error instanceof Error ? error : new Error('GitHub authorization could not open.'),
      );
    }
  });
}

function isForbidden(error: unknown): boolean {
  const candidate = error as {
    status?: number;
    response?: { status?: number };
    message?: string;
  } | null;
  const status = candidate?.status ?? candidate?.response?.status;
  return (
    status === 401 ||
    status === 403 ||
    /\b(401|403|forbidden|unauthorized|admin access)\b/i.test(candidate?.message ?? '')
  );
}

function candidateBadge(candidate: ManagedGitHubCandidate) {
  if (candidate.selected && candidate.status === 'connected') {
    return (
      <Badge variant="success" size="sm">
        Selected
      </Badge>
    );
  }
  if (candidate.status === 'connected') {
    return (
      <Badge variant="secondary" size="sm">
        Available
      </Badge>
    );
  }
  return (
    <Badge variant="warning" size="sm">
      Reconnect
    </Badge>
  );
}

interface GitHubAppSetupCardProps {
  canManage: boolean;
}

export function GitHubAppSetupCard({ canManage }: GitHubAppSetupCardProps) {
  const queryClient = useQueryClient();
  const [confirmDisconnectOpen, setConfirmDisconnectOpen] = useState(false);

  const statusQuery = useGitHubAppStatus(canManage);
  const candidatesQuery = useQuery({
    queryKey: GITHUB_CANDIDATES_KEY,
    queryFn: () => listManagedGitHubCandidates(),
    staleTime: 5_000,
    enabled: canManage,
  });

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: GITHUB_APP_STATUS_KEY }),
      queryClient.invalidateQueries({ queryKey: GITHUB_CANDIDATES_KEY }),
    ]);
  };

  const connectMutation = useMutation({
    mutationFn: async () => openConnectUi(await createManagedGitHubConnectSession()),
    onSuccess: async (connectionId) => {
      if (!connectionId) return;
      successToast('GitHub authorization added');
      await refresh();
    },
    onError: (error: Error) => errorToast(error.message || 'GitHub authorization failed'),
  });

  const reconnectMutation = useMutation({
    mutationFn: async (connectionId: string) =>
      openConnectUi(await createManagedGitHubReconnectSession(connectionId)),
    onSuccess: async (connectionId) => {
      if (!connectionId) return;
      successToast('GitHub authorization refreshed');
      await refresh();
    },
    onError: (error: Error) => errorToast(error.message || 'GitHub reconnect failed'),
  });

  const selectMutation = useMutation({
    mutationFn: (connectionId: string) => selectManagedGitHubCandidate(connectionId),
    onSuccess: async () => {
      successToast('Managed GitHub connection selected');
      await refresh();
    },
    onError: (error: Error) => errorToast(error.message || 'GitHub selection failed'),
  });

  const disconnectMutation = useMutation({
    mutationFn: () => disconnectManagedGitHubConnection(),
    onSuccess: async () => {
      setConfirmDisconnectOpen(false);
      successToast('Managed GitHub disconnected');
      await refresh();
    },
    onError: (error: Error) => errorToast(error.message || 'GitHub disconnect failed'),
  });

  if (!canManage) return null;

  if (statusQuery.isLoading || candidatesQuery.isLoading) {
    return (
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-3 w-64" />
        </div>
        <Skeleton className="h-24 w-full rounded-md" />
      </div>
    );
  }

  if (statusQuery.isError || candidatesQuery.isError) {
    const error = statusQuery.error ?? candidatesQuery.error;
    if (isForbidden(error)) return null;
    return (
      <div className="space-y-2">
        <p className="text-foreground text-sm font-medium">Managed GitHub</p>
        <p className="text-muted-foreground text-sm">Could not load the GitHub connection.</p>
        <Button type="button" variant="outline" size="sm" onClick={() => void refresh()}>
          <RefreshCw className="size-4" />
          Retry
        </Button>
      </div>
    );
  }

  const status = statusQuery.data;
  const candidates = candidatesQuery.data ?? [];
  const selected = status?.selected ?? null;
  const busy =
    connectMutation.isPending ||
    reconnectMutation.isPending ||
    selectMutation.isPending ||
    disconnectMutation.isPending;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-0.5">
          <p className="text-foreground text-sm font-medium">Managed GitHub</p>
          <p className="text-muted-foreground text-xs">
            {selected
              ? `${selected.owner?.login ?? selected.display_name} owns new managed repositories.`
              : 'No managed GitHub connection is selected.'}
          </p>
        </div>
        <Button type="button" size="sm" disabled={busy} onClick={() => connectMutation.mutate()}>
          {connectMutation.isPending ? (
            <Loading className="size-4" />
          ) : (
            <Github className="size-4" />
          )}
          Connect GitHub
        </Button>
      </div>

      {candidates.length === 0 ? (
        <div className="border-border flex min-h-20 items-center border-y py-4">
          <p className="text-muted-foreground text-sm">No GitHub connections available.</p>
        </div>
      ) : (
        <div className="divide-border divide-y border-y">
          {candidates.map((candidate) => {
            const reconnecting =
              reconnectMutation.isPending &&
              reconnectMutation.variables === candidate.connection_id;
            const selecting =
              selectMutation.isPending && selectMutation.variables === candidate.connection_id;
            const missingPermissions = missingManagedGitHubPermissions(candidate);
            return (
              <div
                key={candidate.connection_id}
                className="flex flex-wrap items-center justify-between gap-3 py-3"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-foreground truncate text-sm font-medium">
                      {candidate.owner?.login ?? candidate.display_name}
                    </span>
                    {candidateBadge(candidate)}
                  </div>
                  <div className="text-muted-foreground flex flex-wrap gap-x-3 text-xs">
                    <span>{candidate.display_name}</span>
                    {candidate.installation_id ? (
                      <span>Installation {candidate.installation_id}</span>
                    ) : null}
                  </div>
                  {missingPermissions.length > 0 ? (
                    <p className="text-destructive text-xs">
                      Required GitHub App permissions: {missingPermissions.join(', ')}.
                    </p>
                  ) : null}
                </div>

                <div className="flex items-center gap-2">
                  {!candidate.selected && candidate.status === 'connected' ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => selectMutation.mutate(candidate.connection_id)}
                    >
                      {selecting ? <Loading className="size-4" /> : <Check className="size-4" />}
                      Select
                    </Button>
                  ) : null}
                  {candidate.selected || candidate.status !== 'connected' ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => reconnectMutation.mutate(candidate.connection_id)}
                    >
                      {reconnecting ? (
                        <Loading className="size-4" />
                      ) : (
                        <RotateCcw className="size-4" />
                      )}
                      Reconnect
                    </Button>
                  ) : null}
                  {candidate.selected ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="Disconnect managed GitHub"
                      title="Disconnect"
                      disabled={busy}
                      className="text-destructive hover:text-destructive"
                      onClick={() => setConfirmDisconnectOpen(true)}
                    >
                      <Unplug className="size-4" />
                    </Button>
                  ) : (
                    <Link2 className="text-muted-foreground size-4" aria-hidden="true" />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        open={confirmDisconnectOpen}
        onOpenChange={setConfirmDisconnectOpen}
        title="Disconnect managed GitHub?"
        description="Managed projects keep their repositories. Git operations stop until an administrator reconnects and selects a connection."
        confirmLabel="Disconnect"
        confirmVariant="destructive"
        confirmIcon={<Unplug className="size-4" />}
        onConfirm={() => disconnectMutation.mutate()}
        isPending={disconnectMutation.isPending}
      />
    </div>
  );
}

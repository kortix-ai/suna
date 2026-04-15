'use client';

/**
 * Instance switcher — matches the original compact ServerSelector style.
 * Lives inside the bottom user-menu dropdown.
 *
 * Clicking the current instance opens the Instance Management modal
 * (hoisted to caller via `onOpenSettings`). Clicking any other instance
 * navigates to it.
 */

import * as React from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Loader2, Settings2 } from 'lucide-react';

import { useAuth } from '@/components/AuthProvider';
import { listSandboxes, type SandboxInfo } from '@/lib/platform-client';
import { cn } from '@/lib/utils';
import { isLocalBridgeServer, useServerStore, type ServerEntry } from '@/stores/server-store';
import { useTabStore } from '@/stores/tab-store';

function displayName(s: SandboxInfo): string {
  if (s.name && s.name.trim()) return s.name;
  const id = s.sandbox_id || '';
  if (id.startsWith('sandbox-')) return id.slice(0, 14);
  if (id.length > 16) return id.slice(0, 12) + '…';
  return id || 'Instance';
}

function statusColor(status: string | null | undefined): string {
  switch (status) {
    case 'active':
    case 'running':
      return 'bg-emerald-500';
    case 'provisioning':
      return 'bg-amber-400 animate-pulse';
    case 'pooled':
      return 'bg-blue-400';
    case 'error':
    case 'failed':
      return 'bg-red-500';
    case 'stopped':
    case 'paused':
    case 'archived':
      return 'bg-muted-foreground/40';
    default:
      return 'bg-muted-foreground/20';
  }
}

function getCurrentInstanceIdFromPath(pathname: string | null): string | null {
  if (!pathname) return null;
  const m = pathname.match(/^\/instances\/([^\/]+)/);
  return m ? m[1] : null;
}

function InstanceRow({
  sandbox,
  isActive,
  onSelect,
}: {
  sandbox: SandboxInfo;
  isActive: boolean;
  onSelect: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      className={cn(
        'w-full flex items-center gap-2.5 px-2 py-2 rounded-lg text-left transition-colors cursor-pointer',
        isActive ? 'bg-foreground/[0.04]' : 'hover:bg-muted/50',
      )}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <span
        className={cn('size-[7px] rounded-full shrink-0', statusColor(sandbox.status))}
        aria-hidden
      />
      <div className="flex-1 min-w-0">
        <div
          className={cn(
            'truncate text-xs',
            isActive ? 'text-foreground font-medium' : 'text-muted-foreground',
          )}
        >
          {displayName(sandbox)}
        </div>
      </div>
    </div>
  );
}

function LocalBridgeRow({
  server,
  isActive,
  onSelect,
}: {
  server: ServerEntry;
  isActive: boolean;
  onSelect: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      className={cn(
        'w-full flex items-center gap-2.5 px-2 py-2 rounded-lg text-left transition-colors cursor-pointer',
        isActive ? 'bg-foreground/[0.04]' : 'hover:bg-muted/50',
      )}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <span className="size-[7px] rounded-full shrink-0 bg-blue-500" aria-hidden />
      <div className="flex-1 min-w-0">
        <div className={cn('truncate text-xs', isActive ? 'text-foreground font-medium' : 'text-muted-foreground')}>
          {server.label || 'Local Sandbox'}
        </div>
      </div>
    </div>
  );
}

export function InstanceSwitcherList({
  onAfterSelect,
  onOpenSettings,
}: {
  onAfterSelect?: () => void;
  /** Called when the user clicks their currently-active instance. */
  onOpenSettings?: (sandbox: SandboxInfo) => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { user } = useAuth();
  const currentInstanceId = getCurrentInstanceIdFromPath(pathname);
  const servers = useServerStore((s) => s.servers);
  const activeServerId = useServerStore((s) => s.activeServerId);
  const setActiveServer = useServerStore((s) => s.setActiveServer);

  const { data: sandboxes, isLoading } = useQuery({
    queryKey: ['platform', 'sandbox', 'list'],
    queryFn: listSandboxes,
    enabled: !!user,
    staleTime: 30_000,
  });

  const visible = React.useMemo(
    () => (sandboxes ?? []).filter((s) => s.status !== 'archived'),
    [sandboxes],
  );
  const localBridge = React.useMemo(
    () => servers.find(isLocalBridgeServer) ?? null,
    [servers],
  );

  const handleSelect = (sandbox: SandboxInfo) => {
    if (sandbox.sandbox_id === currentInstanceId) {
      onAfterSelect?.();
      onOpenSettings?.(sandbox);
      return;
    }
    onAfterSelect?.();
    if (sandbox.status === 'active') {
      router.push(`/instances/${sandbox.sandbox_id}/dashboard`);
    } else {
      router.push(`/instances/${sandbox.sandbox_id}`);
    }
  };

  const handleManage = () => {
    onAfterSelect?.();
    router.push('/instances');
  };

  const handleSelectLocalBridge = () => {
    if (!localBridge) return;
    useTabStore.getState().swapForServer(localBridge.id, activeServerId);
    setActiveServer(localBridge.id);
    onAfterSelect?.();
    router.push('/dashboard');
  };

  return (
    <div className="flex flex-col">
      <div className="flex flex-col px-1 max-h-[200px] overflow-y-auto">
        {isLoading && visible.length === 0 ? (
          <div className="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            Loading…
          </div>
        ) : visible.length === 0 ? (
          localBridge ? (
            <LocalBridgeRow
              server={localBridge}
              isActive={localBridge.id === activeServerId}
              onSelect={handleSelectLocalBridge}
            />
          ) : (
            <div className="px-2 py-2 text-xs text-muted-foreground">No instances.</div>
          )
        ) : (
          <>
            {visible.map((s) => (
              <InstanceRow
                key={s.sandbox_id}
                sandbox={s}
                isActive={s.sandbox_id === currentInstanceId}
                onSelect={() => handleSelect(s)}
              />
            ))}
            {localBridge && (
              <LocalBridgeRow
                server={localBridge}
                isActive={localBridge.id === activeServerId}
                onSelect={handleSelectLocalBridge}
              />
            )}
          </>
        )}
      </div>

      <div className="px-1 pt-1">
        <button
          type="button"
          className="flex items-center gap-1.5 w-full px-2 py-1.5 rounded-lg text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors cursor-pointer"
          onClick={handleManage}
        >
          <Settings2 className="size-3" />
          Manage instances
        </button>
      </div>
    </div>
  );
}

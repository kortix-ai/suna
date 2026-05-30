'use client';

import { useTranslations } from 'next-intl';

import * as React from 'react';
import {
  Plus,
  Pencil,
  Search,
  Check,
  X,
  Box,
  Settings2,
  Cloud,
  Container,
  Loader2,
  ArrowDownToLine,
  KeyRound,
  Terminal,
  Copy,
  ExternalLink,
  ChevronDown,
  Download,
  Globe,
  Server,
  CalendarX2,
  Power,
} from 'lucide-react';
import {
  activateServerSelection,
  resolveServerUrl,
  useServerStore,
  type ServerEntry,
} from '@/stores/server-store';
import { buildInstancePath } from '@/lib/instance-routes';
import { useNewInstanceModalStore } from '@/stores/pricing-modal-store';
import { useSubscriptionStore } from '@/stores/subscription-store';
import { cn } from '@/lib/utils';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import { usePathname, useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { authenticatedFetch } from '@/lib/auth-token';
import { useAuth } from '@/components/AuthProvider';
import { createSandbox, ensureSandbox, extractMappedPorts, getSandboxById, getSandboxUrl, getSSHConnection, setupSSH, cancelSandbox, reactivateSandbox, listSandboxes, type SandboxCreateProgress, type SandboxProviderName, type SandboxInfo, type ServerTypeOption, type ChangelogEntry, type SSHConnectionInfo, type SSHSetupResult } from '@/lib/platform-client';
import { toast } from '@/lib/toast';
import { isBillingEnabled } from '@/lib/config';

import { useSandboxUpdate } from '@/hooks/platform/use-sandbox-update';
import { useProviders } from '@/hooks/platform/use-sandbox';
import { useQuery } from '@tanstack/react-query';

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

import { SSHResultView } from './ssh-key-dialog';

// ============================================================================
// Connection status
// ============================================================================

type ConnectionStatus = 'unknown' | 'checking' | 'connected' | 'error';

function useConnectionStatus(url: string, enabled: boolean) {
	const { user, isLoading: isAuthLoading } = useAuth();
  const [status, setStatus] = React.useState<ConnectionStatus>('unknown');
  const [version, setVersion] = React.useState<string | null>(null);

  const check = React.useCallback(async () => {
		if (!url || isAuthLoading || !user) {
			setStatus('unknown');
			setVersion(null);
			return;
		}
    setStatus('checking');
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);

			const sessionRes = await authenticatedFetch(`${url}/session`, {
        method: 'GET',
        signal: controller.signal,
      }, { retryOnAuthError: false });
      clearTimeout(timeout);
			if (!sessionRes.ok) {
				throw new Error(`Session probe failed: ${sessionRes.status}`);
			}
      setStatus('connected');

      // Try to get version from /kortix/health
      try {
        const hres = await authenticatedFetch(`${url}/kortix/health`, {
          signal: AbortSignal.timeout(3000),
        }, { retryOnAuthError: false });
        if (hres.ok) {
          const data = await hres.json();
          if (data.version && data.version !== '0.0.0') {
            setVersion(data.version);
          }
        }
      } catch {
        // Not a cloud sandbox or health endpoint unavailable — that's fine
      }
    } catch {
      setStatus('error');
			setVersion(null);
    }
	}, [url, isAuthLoading, user]);

  React.useEffect(() => {
		if (enabled && !isAuthLoading && user) {
			check();
			return;
		}
		setStatus('unknown');
		setVersion(null);
	}, [enabled, isAuthLoading, user, check]);

  return { status, version, check };
}

function StatusDot({ status }: { status: ConnectionStatus }) {
  return (
    <span className="relative flex-shrink-0 inline-flex">
      {status === 'connected' && (
        <>
          <span className="size-[7px] rounded-full bg-emerald-500" />
          <span className="absolute inset-0 size-[7px] rounded-full bg-emerald-400 animate-ping opacity-40" />
        </>
      )}
      {status === 'error' && <span className="size-[7px] rounded-full bg-red-400" />}
      {status === 'checking' && <span className="size-[7px] rounded-full bg-amber-400 animate-pulse" />}
      {status === 'unknown' && <span className="size-[7px] rounded-full bg-muted-foreground/20" />}
    </span>
  );
}

const statusLabel: Record<ConnectionStatus, string> = {
  unknown: '',
  checking: 'Connecting...',
  connected: 'Connected',
  error: 'Unreachable',
};

function highlightShellToken(token: string) {
  if (/^(ssh|mkdir|cat|chmod)$/.test(token)) return 'text-emerald-600 dark:text-emerald-400';
  if (/^(-[A-Za-z]|--[A-Za-z-]+)/.test(token)) return 'text-amber-600 dark:text-amber-400';
  if (/^(~\/|\/)[^\s]*/.test(token)) return 'text-sky-600 dark:text-sky-400';
  if (/^\d+$/.test(token)) return 'text-violet-600 dark:text-violet-400';
  if (/^'.*'$/.test(token)) return 'text-orange-600 dark:text-orange-400';
  if (/^[A-Z0-9_]+=?$/.test(token)) return 'text-cyan-600 dark:text-cyan-400';
  return 'text-foreground';
}

function renderShellHighlighted(text: string) {
  const lines = text.split('\n');
  return lines.map((line, lineIndex) => {
    const parts = line.split(/(\s+)/);
    return (
      <React.Fragment key={`line-${lineIndex}`}>
        {parts.map((part, partIndex) => {
          if (!part) return null;
          if (/^\s+$/.test(part)) {
            return <span key={`part-${lineIndex}-${partIndex}`}>{part}</span>;
          }
          return (
            <span key={`part-${lineIndex}-${partIndex}`} className={highlightShellToken(part)}>
              {part}
            </span>
          );
        })}
        {lineIndex < lines.length - 1 ? '\n' : null}
      </React.Fragment>
    );
  });
}

function renderSshConfigHighlighted(config: string) {
  const lines = config.split('\n');
  return lines.map((line, index) => {
    if (!line.trim()) {
      return <React.Fragment key={`cfg-${index}`}>{index < lines.length - 1 ? '\n' : null}</React.Fragment>;
    }
    const match = line.match(/^(\s*)(\S+)(\s+)(.+)$/);
    if (!match) {
      return (
        <React.Fragment key={`cfg-${index}`}>
          <span className="text-foreground">{line}</span>
          {index < lines.length - 1 ? '\n' : null}
        </React.Fragment>
      );
    }
    const [, indent, key, spacing, value] = match;
    return (
      <React.Fragment key={`cfg-${index}`}>
        <span>{indent}</span>
        <span className="text-cyan-600 dark:text-cyan-400">{key}</span>
        <span>{spacing}</span>
        <span className="text-foreground break-all">{value}</span>
        {index < lines.length - 1 ? '\n' : null}
      </React.Fragment>
    );
  });
}

const SSH_META_STORAGE_KEY = 'kortix:ssh-access-meta:v1';

type SSHAccessMeta = {
  ssh_command: string;
  reconnect_command: string;
  ssh_config_entry: string;
  ssh_config_command: string;
  host: string;
  port: number;
  username: string;
  provider: string;
  key_name: string;
  host_alias: string;
  updatedAt: number;
};

// ============================================================================
// Instance row — compact (sidebar inline list)
// ============================================================================

/** Derive a clean display name from the server entry. */
function getInstanceName(server: ServerEntry): string {
  // If there's a custom label that's not a URL, use it
  const resolvedUrl = resolveServerUrl(server);
  const displayUrl = resolvedUrl.replace(/^https?:\/\//, '');
  if (server.label && server.label !== displayUrl) return server.label;
  // Extract sandbox ID from instanceId or sandboxId
  const id = server.instanceId || server.sandboxId || '';
  // "sandbox-2a8b9aab" → "sandbox-2a8b" (short enough to read)
  if (id.startsWith('sandbox-')) return id.slice(0, 14);
  if (id.length > 16) return id.slice(0, 12) + '…';
  return id || displayUrl.split('/')[0];
}

function CompactInstanceRow({
  server,
  isActive,
  onSelect,
}: {
  server: ServerEntry;
  isActive: boolean;
  onSelect: () => void;
}) {
  const resolvedUrl = resolveServerUrl(server);
  const { status } = useConnectionStatus(resolvedUrl, isActive);
  const name = getInstanceName(server);
  const provider = server.provider || 'cloud';

  return (
    <div
      role="button"
      tabIndex={0}
      className={cn(
        'w-full flex items-center gap-2.5 px-2 py-2 rounded-lg text-left transition-colors cursor-pointer',
        isActive ? 'bg-foreground/[0.04]' : 'hover:bg-muted/50',
      )}
      onClick={onSelect}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); } }}
    >
      <StatusDot status={isActive ? status : 'unknown'} />
      <div className="flex-1 min-w-0">
        <div className={cn(
          'truncate text-xs',
          isActive ? 'text-foreground font-medium' : 'text-muted-foreground',
        )}>
          {name}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Instance row — full (dialog list). Stacked layout so URLs never cut off.
// ============================================================================

type SandboxUpdateInfo = {
  updateAvailable: boolean;
  currentVersion: string | null;
  latestVersion: string | null;
  changelog: ChangelogEntry | null;
  update: () => void;
  isUpdating: boolean;
  isLoading: boolean;
};

function DialogInstanceRow({
  server,
  isActive,
  onSelect,
  onEdit,
  onCancel,
  onReactivate,
  sandboxInfo,
  isCancelling,
  isReactivating,
  sandboxUpdate,
  onVersionDetected,
}: {
  server: ServerEntry;
  isActive: boolean;
  onSelect: () => void;
  onEdit?: () => void;
  onCancel?: () => void;
  onReactivate?: () => void;
  sandboxInfo?: SandboxInfo;
  isCancelling?: boolean;
  isReactivating?: boolean;
  sandboxUpdate?: SandboxUpdateInfo;
  onVersionDetected?: (version: string) => void;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const resolvedUrl = resolveServerUrl(server);
  const displayUrl = resolvedUrl.replace(/^https?:\/\//, '');
  const hasCustomLabel = server.label && server.label !== displayUrl;

  // DB status is the source of truth. Do not probe every active row in the
  // instance list; inactive JustaVPS rows can be stopped/dead and were causing
  // repeated /v1/p/{sandbox}/8000/kortix/health 502s. Only the selected row
  // gets a live health/version check.
  const dbStatus = sandboxInfo?.status;
  const isDbActive = !dbStatus || dbStatus === 'active';
  const { status: connStatus, version } = useConnectionStatus(resolvedUrl, isActive && isDbActive);

  const isCancelledAtPeriodEnd = sandboxInfo?.cancel_at_period_end ?? false;
  const cancelAt = sandboxInfo?.cancel_at ?? null;
  const isPaidVps = server.provider === 'justavps' && Boolean(sandboxInfo?.stripe_subscription_id || sandboxInfo?.stripe_subscription_item_id);

  // Report version back to parent when detected
  React.useEffect(() => {
    if (version && onVersionDetected) onVersionDetected(version);
  }, [version, onVersionDetected]);

  // Derive display status: DB status takes priority, health check only for active sandboxes
  const displayStatus = React.useMemo(() => {
    if (dbStatus === 'provisioning') return { label: 'Provisioning...', color: 'text-amber-500', dot: 'checking' as ConnectionStatus };
    if (dbStatus === 'stopped') return { label: 'Stopped', color: 'text-muted-foreground', dot: 'error' as ConnectionStatus };
    if (dbStatus === 'error') return { label: 'Error', color: 'text-red-400', dot: 'error' as ConnectionStatus };
    // active or no sandbox info (custom URL) — use connection health check
    if (connStatus === 'connected') return { label: 'Connected', color: 'text-emerald-500', dot: 'connected' as ConnectionStatus };
    if (connStatus === 'error') return { label: 'Unreachable', color: 'text-red-400', dot: 'error' as ConnectionStatus };
    if (connStatus === 'checking') return { label: 'Connecting...', color: 'text-amber-500', dot: 'checking' as ConnectionStatus };
    return null;
  }, [dbStatus, connStatus]);

  // Provider icon
  const ProviderIcon = server.provider === 'local_docker' ? Container
    : server.provider === 'daytona' ? Cloud
    : server.provider === 'justavps' ? Server
    : Box;

  // Provider badge
  const providerBadge = server.provider === 'local_docker' ? { label: 'local' }
    : server.provider === 'justavps' ? { label: 'vps' }
    : server.provider ? { label: 'cloud' }
    : null;

  return (
    <div
      className={cn(
        'relative rounded-2xl transition-colors group/row cursor-pointer',
        isActive
          ? 'bg-primary/[0.05] dark:bg-primary/[0.08] ring-1 ring-primary/15'
          : 'hover:bg-muted/50',
      )}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); } }}
    >
      <div className="px-3.5 py-3">
        {/* Top line: icon + label + badges */}
        <div className="flex items-center gap-2">
          <ProviderIcon className={cn('h-4 w-4 flex-shrink-0', isActive ? 'text-primary' : 'text-muted-foreground/60')} />
          <span className={cn(
            'text-sm leading-tight flex-1 min-w-0 break-all',
            isActive ? 'text-foreground font-semibold' : 'text-foreground/80 font-medium',
            !hasCustomLabel && 'font-mono text-sm',
          )}>
            {hasCustomLabel ? server.label : displayUrl}
          </span>

          {providerBadge && (
            <Badge size="sm" variant="secondary" className="uppercase tracking-wider flex-shrink-0">
              {providerBadge.label}
            </Badge>
          )}
          {isCancelledAtPeriodEnd && (
            <span className="flex items-center gap-0.5 px-1.5 py-px text-xs font-medium rounded-full uppercase tracking-wider leading-none flex-shrink-0 bg-destructive/10 text-destructive border border-destructive/20">
              <CalendarX2 className="h-2.5 w-2.5" />
              Cancelling
            </span>
          )}
          {server.isDefault && (
            <span className="px-1.5 py-px text-xs font-medium text-muted-foreground/60 bg-muted/50 rounded-full uppercase tracking-wider leading-none flex-shrink-0">
              default
            </span>
          )}
          {isActive && <Check className="h-4 w-4 text-primary flex-shrink-0" />}
        </div>

        {/* URL — only when label differs from URL */}
        {hasCustomLabel && (
          <p className="mt-1 ml-6 text-xs text-muted-foreground/50 font-mono break-all leading-relaxed">
            {displayUrl}
          </p>
        )}

        {/* Status + version + actions */}
        <div className="mt-1.5 ml-6 flex items-center gap-3 flex-wrap">
          {displayStatus && (
            <span className={cn('flex items-center gap-1 text-xs font-medium', displayStatus.color)}>
              <StatusDot status={displayStatus.dot} />
              {displayStatus.label}
            </span>
          )}

          {version && (
            <span className="text-xs font-mono text-muted-foreground/60">v{version}</span>
          )}

          {/* Update available */}
          {sandboxUpdate?.updateAvailable && !sandboxUpdate.isUpdating && (
            <Button
              type="button"
              variant="subtle"
              size="xs"
              className="rounded-full"
              onClick={(e) => { e.stopPropagation(); sandboxUpdate.update(); }}
            >
              <ArrowDownToLine className="h-3 w-3" />{tHardcodedUi.raw('componentsSidebarServerSelector.line451JsxTextUpdateToV')}{' '}{sandboxUpdate.latestVersion}
            </Button>
          )}

          {/* Updating */}
          {sandboxUpdate?.isUpdating && (
            <span className="flex items-center gap-1 text-xs font-medium text-amber-500">
              <Loader2 className="h-3 w-3 animate-spin" />
              Updating...
            </span>
          )}

          {/* Changelog */}
          {sandboxUpdate?.updateAvailable && !sandboxUpdate.isUpdating && sandboxUpdate.changelog && (
            <div className="basis-full mt-0.5 text-xs text-muted-foreground/70 space-y-0.5 max-w-[280px]">
              <p className="font-medium">{sandboxUpdate.changelog.title}</p>
              <ul className="list-disc list-inside">
                {sandboxUpdate.changelog.changes.slice(0, 3).map((c, i) => (
                  <li key={i} className="truncate">{c.text}</li>
                ))}
                {sandboxUpdate.changelog.changes.length > 3 && (
                  <li className="text-muted-foreground/50">+{sandboxUpdate.changelog.changes.length - 3} more</li>
                )}
              </ul>
            </div>
          )}

          <div className="flex-1" />

          {/* Hover actions */}
          <div className="flex items-center gap-1 opacity-0 group-hover/row:opacity-100 transition-opacity" onClick={(e) => e.stopPropagation()}>
            {/* Edit — non-default entries only */}
            {!server.isDefault && onEdit && (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={(e) => { e.stopPropagation(); onEdit(); }}
                aria-label="Edit"
              >
                <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
              </Button>
            )}
            {/* Cancel / Reactivate — paid VPS only */}
            {isPaidVps && isCancelledAtPeriodEnd && (
              <Button
                type="button"
                disabled={isReactivating}
                variant="success"
                size="xs"
                onClick={(e) => { e.stopPropagation(); onReactivate?.(); }}
              >
                {isReactivating ? <Loader2 className="h-3 w-3 animate-spin" /> : <Power className="h-3 w-3" />}
                Reactivate
              </Button>
            )}
            {isPaidVps && !isCancelledAtPeriodEnd && (
              <Button
                type="button"
                disabled={isCancelling}
                variant="muted"
                size="xs"
                onClick={(e) => { e.stopPropagation(); onCancel?.(); }}
              >
                {isCancelling ? <Loader2 className="h-3 w-3 animate-spin" /> : <CalendarX2 className="h-3 w-3" />}
                Cancel
              </Button>
            )}
          </div>
        </div>

        {/* Cancellation notice */}
        {isCancelledAtPeriodEnd && (
          <p className="mt-1.5 ml-6 text-xs text-destructive">
            {cancelAt
              ? `Ends ${new Date(cancelAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`
              : 'Cancels at end of billing period'}
          </p>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Instance Manager Dialog
// ============================================================================

export function InstanceManagerDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const { servers, activeServerId, addServer, updateServer } =
    useServerStore();
  const { user, isLoading: isAuthLoading } = useAuth();
  const accountState = useSubscriptionStore((s) => s.accountState);
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const [search, setSearch] = React.useState('');
  const [mode, setMode] = React.useState<'list' | 'add' | 'edit' | 'ssh' | 'custom'>('list');
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [isCreatingSandbox, setIsCreatingSandbox] = React.useState(false);
  const [creatingProvider, setCreatingProvider] = React.useState<SandboxProviderName | null>(null);
  const [sandboxError, setSandboxError] = React.useState<string | null>(null);
  const [sandboxProgress, setSandboxProgress] = React.useState<SandboxCreateProgress | null>(null);
  // Track the cloud sandbox's current version (from /kortix/health, fetched by DialogInstanceRow)
  const [sandboxVersion, setSandboxVersion] = React.useState<string | null>(null);

  // SSH state
  const [isGeneratingSSH, setIsGeneratingSSH] = React.useState(false);
  const [sshResult, setSSHResult] = React.useState<SSHSetupResult | null>(null);
  const [sshMeta, setSSHMeta] = React.useState<SSHAccessMeta | null>(null);
  const [sshError, setSSHError] = React.useState<string | null>(null);
  const [copiedField, setCopiedField] = React.useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = React.useState(false);

  // Cancel / reactivate state
  const [cancellingId, setCancellingId] = React.useState<string | null>(null);
  const [reactivatingId, setReactivatingId] = React.useState<string | null>(null);
  const [pendingCancelServer, setPendingCancelServer] = React.useState<ServerEntry | null>(null);

  // Fetch full sandbox list to get cancel_at_period_end / stripe fields
  const { data: sandboxList } = useQuery({
    queryKey: ['platform', 'sandbox', 'list', user?.id ?? 'anonymous'],
    queryFn: listSandboxes,
    enabled: open && !isAuthLoading && !!user,
    staleTime: 30_000,
  });

  function getSandboxInfo(server: ServerEntry): SandboxInfo | undefined {
    if (!sandboxList) return undefined;
    if (server.instanceId) {
      return sandboxList.find((s) => s.sandbox_id === server.instanceId);
    }
    if (server.sandboxId) {
      return sandboxList.find((s) => s.external_id === server.sandboxId || s.sandbox_id === server.sandboxId);
    }
    return undefined;
  }

  async function handleCancelConfirmed() {
    if (!pendingCancelServer) return;
    const server = pendingCancelServer;
    setPendingCancelServer(null);
    setCancellingId(server.id);
    try {
      await cancelSandbox(server.sandboxId);
      await queryClient.invalidateQueries({ queryKey: ['platform', 'sandbox', 'list'] });
      toast.success(`${server.label || 'Instance'} scheduled for cancellation`);
    } catch (err: any) {
      toast.error(err?.message || 'Failed to schedule cancellation');
    } finally {
      setCancellingId(null);
    }
  }

  async function handleReactivate(server: ServerEntry) {
    setReactivatingId(server.id);
    try {
      await reactivateSandbox(server.sandboxId);
      await queryClient.invalidateQueries({ queryKey: ['platform', 'sandbox', 'list'] });
      toast.success(`${server.label || 'Instance'} reactivated`);
    } catch (err: any) {
      toast.error(err?.message || 'Failed to reactivate');
    } finally {
      setReactivatingId(null);
    }
  }

  // Sandbox update state — only used for the cloud sandbox row
  const sandboxUpdate = useSandboxUpdate(sandboxVersion);

  // Available providers from the backend
  const { data: providersInfo } = useProviders();
  const availableProviders = providersInfo?.providers ?? ['local_docker'];
  const hasDaytona = availableProviders.includes('daytona');
  const hasLocalDocker = availableProviders.includes('local_docker');
  const hasJustAVPS = availableProviders.includes('justavps');
  const canAddInstances = accountState?.can_add_instances ?? false;

  // Form state (for custom URL / edit)
  const [formUrl, setFormUrl] = React.useState('');
  const [formLabel, setFormLabel] = React.useState('');
  const urlInputRef = React.useRef<HTMLInputElement>(null);

  const filtered = React.useMemo(() => {
    if (!search.trim()) return servers;
    const q = search.toLowerCase();
    return servers.filter((s) => (s.label || '').toLowerCase().includes(q) || (s.url || '').toLowerCase().includes(q));
  }, [servers, search]);

  // Reset state when dialog opens
  React.useEffect(() => {
    if (open) {
      setMode('list');
      setSearch('');
      setEditingId(null);
      setFormUrl('');
      setFormLabel('');
      setSandboxError(null);
      setSandboxProgress(null);
      setSSHResult(null);
      setSSHError(null);
      setShowAdvanced(false);
      setPendingCancelServer(null);
      setCancellingId(null);
      setReactivatingId(null);

      try {
        const raw = localStorage.getItem(SSH_META_STORAGE_KEY);
        if (!raw) {
          setSSHMeta(null);
        } else {
          const parsed = JSON.parse(raw) as SSHAccessMeta;
          if (parsed?.ssh_command && parsed?.host && parsed?.username && parsed?.port) {
            setSSHMeta(parsed);
          } else {
            setSSHMeta(null);
          }
        }
      } catch {
        setSSHMeta(null);
      }

      const activeServer = servers.find((s) => s.id === activeServerId);
      getSSHConnection(activeServer?.instanceId).then((connection: SSHConnectionInfo) => {
        setSSHMeta((prev) => ({
          ...connection,
          updatedAt: prev?.updatedAt || Date.now(),
        }));
      }).catch(() => {});
    }
  }, [open, servers, activeServerId]);

  // Focus URL input when entering custom/edit mode
  React.useEffect(() => {
    if ((mode === 'custom' || mode === 'edit') && urlInputRef.current) {
      const timer = setTimeout(() => urlInputRef.current?.focus(), 100);
      return () => clearTimeout(timer);
    }
  }, [mode]);

  function startEdit(server: ServerEntry) {
    setEditingId(server.id);
    setFormUrl(server.url);
    setFormLabel(server.label);
    setMode('edit');
  }

  function handleSaveCustom() {
    const url = formUrl.trim();
    if (!url) return;
    const label = formLabel.trim();

    if (mode === 'custom') {
      const newServer = addServer(label, url);
      const result = activateServerSelection(newServer.id, { pathname });
      router.push(result?.href ?? (newServer.instanceId ? buildInstancePath(newServer.instanceId, '/dashboard') : '/dashboard'));
      onOpenChange(false);
    } else if (mode === 'edit' && editingId) {
      updateServer(editingId, { label: label || url.replace(/^https?:\/\//, ''), url });
      setMode('list');
      setEditingId(null);
    }
  }

  async function handleCreateSandbox(provider: SandboxProviderName, serverType?: ServerTypeOption) {
    setIsCreatingSandbox(true);
    setCreatingProvider(provider);
    setSandboxError(null);
    setSandboxProgress(null);
    let managedVpsProgressTimer: ReturnType<typeof setInterval> | null = null;
    const isManagedVpsProvider = provider === 'justavps';
    const providerLabel = provider === 'justavps' ? 'JustaVPS' : 'Cloud Sandbox';
    if (isManagedVpsProvider) {
      const startedAt = Date.now();
      const tick = () => {
        const elapsedSec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
        let progress = 8;
        let message = `Allocating ${providerLabel}...`;

        if (elapsedSec < 20) {
          progress = 8 + (elapsedSec / 20) * 12;
          message = `Allocating ${providerLabel}...`;
        } else if (elapsedSec < 90) {
          progress = 20 + ((elapsedSec - 20) / 70) * 35;
          message = 'Provisioning from snapshot (cold starts usually 2-3 min)...';
        } else if (elapsedSec < 150) {
          progress = 55 + ((elapsedSec - 90) / 60) * 30;
          message = 'Booting sandbox services...';
        } else {
          progress = Math.min(95, 85 + ((elapsedSec - 150) / 120) * 10);
          message = 'Running final health checks...';
        }

        setSandboxProgress({
          status: 'pulling',
          progress: Math.max(2, Math.min(95, progress)),
          message,
        });
      };

      tick();
      managedVpsProgressTimer = setInterval(tick, 1000);
    }
    try {
      // In cloud mode (billing), use ensureSandbox (idempotent — handles archived → reactivate → create).
      // In self-hosted mode, use createSandbox (explicit creation).
      const isCloudProvider = provider === 'daytona' || isManagedVpsProvider;
      const { sandbox } = isBillingEnabled() && isCloudProvider
        ? await ensureSandbox({ provider, serverType })
        : await createSandbox({
            provider,
            serverType,
          });
      let readySandbox = sandbox;

      // Managed VPS providers can report as active before services are actually ready.
      // Do not route to dashboard until /kortix/health returns a real version.
      if (isManagedVpsProvider) {
        if (managedVpsProgressTimer) {
          clearInterval(managedVpsProgressTimer);
          managedVpsProgressTimer = null;
        }

        const readyDeadline = Date.now() + 180_000;
        let readyVersion = '';

        while (Date.now() < readyDeadline) {
          const remaining = Math.max(0, readyDeadline - Date.now());
          const elapsed = 180_000 - remaining;
          const progress = Math.min(99, 90 + (elapsed / 180_000) * 9);
          setSandboxProgress({
            status: 'pulling',
            progress,
            message: `Provisioning ${providerLabel} services and waiting for health...`,
          });

          try {
            const refreshed = await getSandboxById(sandbox.sandbox_id).catch(() => null);
            if (!refreshed || refreshed.status !== 'active' || !refreshed.external_id) {
              await new Promise((resolve) => setTimeout(resolve, 2000));
              continue;
            }
            readySandbox = refreshed;
            const sandboxUrl = getSandboxUrl(refreshed);
            const res = await authenticatedFetch(
              `${sandboxUrl}/kortix/health`,
              { signal: AbortSignal.timeout(5000) },
              { retryOnAuthError: false },
            );
            if (res.ok) {
              const health = await res.json().catch(() => null) as { version?: string } | null;
              const version = typeof health?.version === 'string' ? health.version : '';
              if (version && version !== '0.0.0') {
                readyVersion = version;
                break;
              }
            }
          } catch {
            // keep polling until ready or timeout
          }

          await new Promise((resolve) => setTimeout(resolve, 2000));
        }

        if (!readyVersion) {
          throw new Error(`${providerLabel} created but not ready yet. Please wait a bit and try again.`);
        }

        setSandboxProgress({
          status: 'pulling',
          progress: 100,
          message: `Provisioning ${providerLabel}... Connected (${readyVersion})`,
        });
      }

      const label = readySandbox.name || (provider === 'local_docker'
        ? 'Local Sandbox'
        : provider === 'justavps'
          ? 'JustaVPS'
          : 'Cloud Sandbox');
      const isLocal = readySandbox.provider === 'local_docker';

      const store = useServerStore.getState();

      // Use the centralized registerOrUpdateSandbox which uses stable IDs
      // ('default' for local, 'cloud-sandbox' for cloud) — no duplicates.
      const serverId = store.registerOrUpdateSandbox(
        {
          label,
          provider: readySandbox.provider,
          sandboxId: readySandbox.external_id,
          instanceId: readySandbox.sandbox_id,
          mappedPorts: extractMappedPorts(readySandbox),
        },
        { autoSwitch: false, isLocal },
      );

      // Invalidate sandbox query so useSandbox picks up the latest state.
      queryClient.invalidateQueries({ queryKey: ['platform', 'sandbox'] });
      const result = activateServerSelection(serverId, { pathname });
      router.push(result?.href ?? (readySandbox.sandbox_id ? buildInstancePath(readySandbox.sandbox_id, '/dashboard') : '/dashboard'));
      onOpenChange(false);
    } catch (err: any) {
      let message = err?.message || 'Failed to create sandbox';
      try {
        const parsed = JSON.parse(message) as Partial<SandboxCreateProgress>;
        if (parsed?.status === 'pulling') {
          setSandboxProgress({
            status: 'pulling',
            progress: Math.max(0, Math.min(100, Number(parsed.progress) || 0)),
            message: parsed.message || 'Provisioning sandbox...',
          });
          message = '';
        } else if (parsed?.message) {
          message = parsed.message;
        }
      } catch {
        // ignore non-JSON error payloads
      }
      setSandboxError(message || null);
    } finally {
      if (managedVpsProgressTimer) {
        clearInterval(managedVpsProgressTimer);
      }
      setIsCreatingSandbox(false);
      setCreatingProvider(null);
    }
  }

  function handleSelect(id: string) {
    if (id === activeServerId) return;
    const server = servers.find((s) => s.id === id);
    const result = activateServerSelection(id, { pathname });
    router.push(result?.href ?? (server?.instanceId ? buildInstancePath(server.instanceId, '/dashboard') : '/dashboard'));
    onOpenChange(false);
  }

  async function handleGenerateSSH() {
    setIsGeneratingSSH(true);
    setSSHError(null);
    setSSHResult(null);
    try {
      const activeServer = servers.find((s) => s.id === activeServerId);
      const result = await setupSSH(activeServer?.instanceId);
      setSSHResult(result);
      const meta: SSHAccessMeta = {
        ...result,
        updatedAt: Date.now(),
      };
      setSSHMeta(meta);
      try {
        localStorage.setItem(SSH_META_STORAGE_KEY, JSON.stringify(meta));
      } catch {}
      setMode('ssh');
      toast.success('SSH keys generated successfully');
    } catch (err: any) {
      setSSHError(err?.message || 'Failed to generate SSH keys');
      toast.error(err?.message || 'Failed to generate SSH keys');
    } finally {
      setIsGeneratingSSH(false);
    }
  }

  function copyToClipboard(text: string, field: string) {
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    toast.success('Copied to clipboard');
    setTimeout(() => setCopiedField(null), 2000);
  }

  async function savePrivateKey() {
    if (!sshResult) return;
    const blob = new Blob([sshResult.private_key], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = sshResult.key_name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success(`Key downloaded — run: chmod 600 ~/Downloads/${sshResult.key_name}`);
  }

  // Compute description text based on mode
  const modeDescription: Record<string, string> = {
    list: 'Manage your Kortix instances.',
    add: 'Choose how to connect.',
    custom: 'Connect to a Kortix instance by entering its address.',
    edit: 'Update the connection details for this instance.',
    ssh: 'Connect via SSH or VS Code Remote SSH.',
  };

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          'p-0 gap-0 overflow-hidden flex flex-col max-h-[88vh] w-[min(92vw,620px)]',
          mode === 'ssh' ? 'sm:max-w-xl' : 'sm:max-w-lg',
        )}
        aria-describedby="instance-dialog-desc"
      >
        <DialogHeader className="px-5 pt-5 pb-3">
          <DialogTitle className="flex items-center gap-2 text-base">
            {mode === 'list' ? (
              <>
                <Box className="h-4 w-4 text-muted-foreground" />
                Instances
              </>
            ) : mode === 'ssh' ? (
              <>
                <KeyRound className="h-4 w-4 text-muted-foreground" />{tHardcodedUi.raw('componentsSidebarServerSelector.line970JsxTextSshAccess')}</>
            ) : mode === 'add' ? (
              <>
                <Plus className="h-4 w-4 text-muted-foreground" />{tHardcodedUi.raw('componentsSidebarServerSelector.line975JsxTextNewInstance')}</>
            ) : mode === 'custom' ? 'Custom Instance' : 'Edit Instance'}
          </DialogTitle>
          <DialogDescription id="instance-dialog-desc" className="text-xs">
            {modeDescription[mode] || ''}
          </DialogDescription>
        </DialogHeader>

        {/* ──── List view ──── */}
        {mode === 'list' && (
          <div className="flex flex-col">
            {/* Search (only when 3+ instances) */}
            {servers.length >= 3 && (
              <div className="px-4 pb-3">
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/50 pointer-events-none" />
                  <Input type="text"
                    placeholder={tHardcodedUi.raw('componentsSidebarServerSelector.line993JsxAttrPlaceholderSearchInstances')} autoComplete="off"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="h-8 text-xs pl-8 pr-3"
                  />
                </div>
              </div>
            )}

            {/* Instance list */}
            <div className="flex flex-col gap-1.5 px-3 pb-3 max-h-[400px] overflow-y-auto">
              {filtered.length === 0 ? (
                <div className="py-8 text-center text-sm text-muted-foreground/60">
                  {search ? `No instances match "${search}"` : 'No instances yet'}
                </div>
              ) : (
                filtered.map((server) => (
                  <DialogInstanceRow
                    key={server.id}
                    server={server}
                    isActive={server.id === activeServerId}
                    onSelect={() => handleSelect(server.id)}
                    onEdit={() => startEdit(server)}
                    onCancel={() => setPendingCancelServer(server)}
                    onReactivate={() => handleReactivate(server)}
                    sandboxInfo={getSandboxInfo(server)}
                    isCancelling={cancellingId === server.id}
                    isReactivating={reactivatingId === server.id}
                    sandboxUpdate={server.provider === 'daytona' ? sandboxUpdate : undefined}
                    onVersionDetected={server.provider === 'daytona' ? setSandboxVersion : undefined}
                  />
                ))
              )}
            </div>

            {/* Footer: New Instance + SSH */}
            <div className="border-t border-border/40 px-4 py-3 flex flex-col gap-2">
              {sandboxError && (
                <p className="text-xs text-destructive">{sandboxError}</p>
              )}
              {sshError && (
                <p className="text-xs text-destructive">{sshError}</p>
              )}

              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  onClick={() => setMode('add')}
                  className="flex-1"
                >
                  <Plus className="h-3.5 w-3.5" />{tHardcodedUi.raw('componentsSidebarServerSelector.line1044JsxTextNewInstance')}</Button>

                {servers.length > 0 && (
                  <Button
                    type="button"
                    onClick={handleGenerateSSH}
                    disabled={isGeneratingSSH}
                    title={tHardcodedUi.raw('componentsSidebarServerSelector.line1052JsxAttrTitleGenerateSshKeyForSandbox')}
                    variant="outline"
                    size="icon"
                  >
                    {isGeneratingSSH ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <KeyRound className="h-3.5 w-3.5" />
                    )}
                  </Button>
                )}
              </div>

              {servers.length > 0 && sshMeta && (
                <div className="rounded-2xl border border-border/40 bg-muted/20 px-3 py-2.5 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-medium text-foreground/80">{tHardcodedUi.raw('componentsSidebarServerSelector.line1068JsxTextSshAccess')}</p>
                    <Button
                      type="button"
                      onClick={() => setMode('ssh')}
                      variant="ghost"
                      size="xs"
                      className="text-muted-foreground hover:text-foreground"
                    >{tHardcodedUi.raw('componentsSidebarServerSelector.line1076JsxTextOpenSetup')}</Button>
                  </div>
                  <pre className="max-w-full text-xs font-mono bg-muted/40 border border-border rounded-2xl px-2.5 py-2 overflow-x-hidden whitespace-pre-wrap break-all text-foreground">
                    {renderShellHighlighted(sshMeta.ssh_command)}
                  </pre>
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs text-muted-foreground/50">{tHardcodedUi.raw('componentsSidebarServerSelector.line1083JsxTextLastGenerated')}{' '}{new Date(sshMeta.updatedAt).toLocaleString()}</p>
                    <div className="flex items-center gap-1.5">
                      <Button
                        type="button"
                        onClick={() => copyToClipboard(`ssh ${sshMeta.host_alias}`, 'quick-short')}
                        variant="outline"
                        size="toolbar"
                      >
                        {copiedField === 'quick-short' ? <Check className="h-3 w-3 text-primary" /> : <Copy className="h-3 w-3 text-muted-foreground" />}
                        {copiedField === 'quick-short' ? 'Copied' : `Copy ssh ${sshMeta.host_alias}`}
                      </Button>
                      <Button
                        type="button"
                        onClick={() => copyToClipboard(sshMeta.ssh_command, 'quick-connect')}
                        variant="outline"
                        size="toolbar"
                      >
                        {copiedField === 'quick-connect' ? <Check className="h-3 w-3 text-primary" /> : <Copy className="h-3 w-3 text-muted-foreground" />}
                        {copiedField === 'quick-connect' ? 'Copied' : 'Copy full command'}
                      </Button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ──── Add view — pick instance type ──── */}
        {mode === 'add' && (
          <div className="flex flex-col gap-3 px-5 pb-5">
            {sandboxError && (
              <p className="text-xs text-destructive">{sandboxError}</p>
            )}

            {sandboxProgress && (
              <div className="rounded-2xl border border-border/40 bg-muted/20 px-3 py-2.5 space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs text-muted-foreground">{sandboxProgress.message}</p>
                  <span className="text-xs tabular-nums text-muted-foreground/80">{Math.round(sandboxProgress.progress)}%</span>
                </div>
                <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full rounded-full bg-primary/90 transition-colors duration-1000 ease-out"
                    style={{ width: `${Math.max(sandboxProgress.progress, 2)}%` }}
                  />
                </div>
              </div>
            )}

            <div className="flex flex-col gap-2">
              {!isBillingEnabled() && hasDaytona && (
                <button
                  type="button"
                  onClick={() => handleCreateSandbox('daytona')}
                  disabled={isCreatingSandbox}
                  className="flex items-start gap-3 w-full p-3.5 rounded-2xl border border-border/50 bg-muted/30 hover:bg-muted/50 hover:border-primary/30 text-left transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <div className="flex items-center justify-center h-9 w-9 rounded-lg border border-border/70 bg-muted/40 flex-shrink-0 mt-0.5">
                    {isCreatingSandbox && creatingProvider === 'daytona' ? (
                      <Loader2 className="h-4 w-4 text-muted-foreground animate-spin" />
                    ) : (
                      <Cloud className="h-4 w-4 text-muted-foreground" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground">Cloud</p>
                    <p className="text-xs text-muted-foreground/70 mt-0.5">{tHardcodedUi.raw('componentsSidebarServerSelector.line1150JsxTextManagedSandboxOnDaytonaCloud')}</p>
                  </div>
                </button>
              )}

              {!isBillingEnabled() && hasJustAVPS && (
                <button
                  type="button"
                  onClick={() => handleCreateSandbox('justavps')}
                  disabled={isCreatingSandbox}
                  className="flex items-start gap-3 w-full p-3.5 rounded-2xl border border-border/50 bg-muted/30 hover:bg-muted/50 hover:border-primary/30 text-left transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <div className="flex items-center justify-center h-9 w-9 rounded-lg border border-border/70 bg-muted/40 flex-shrink-0 mt-0.5">
                    {isCreatingSandbox && creatingProvider === 'justavps' ? (
                      <Loader2 className="h-4 w-4 text-muted-foreground animate-spin" />
                    ) : (
                      <Server className="h-4 w-4 text-muted-foreground" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground">JustaVPS</p>
                    <p className="text-xs text-muted-foreground/70 mt-0.5">{tHardcodedUi.raw('componentsSidebarServerSelector.line1171JsxTextCreateAManagedVpsViaJustavps')}</p>
                  </div>
                </button>
              )}

              {hasLocalDocker && (
                <button
                  type="button"
                  onClick={() => handleCreateSandbox('local_docker')}
                  disabled={isCreatingSandbox}
                  className="flex items-start gap-3 w-full p-3.5 rounded-2xl border border-border/50 bg-muted/30 hover:bg-muted/50 hover:border-primary/30 text-left transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <div className="flex items-center justify-center h-9 w-9 rounded-lg border border-border/70 bg-muted/40 flex-shrink-0 mt-0.5">
                    {isCreatingSandbox && creatingProvider === 'local_docker' ? (
                      <Loader2 className="h-4 w-4 text-muted-foreground animate-spin" />
                    ) : (
                      <Container className="h-4 w-4 text-muted-foreground" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground">{tHardcodedUi.raw('componentsSidebarServerSelector.line1191JsxTextLocalDocker')}</p>
                    <p className="text-xs text-muted-foreground/70 mt-0.5">{tHardcodedUi.raw('componentsSidebarServerSelector.line1193JsxTextConnectToAnAlreadyRunningLocalSandbox')}</p>
                  </div>
                </button>
              )}

              {isBillingEnabled() && canAddInstances && (
                <button
                  type="button"
                  onClick={() => useNewInstanceModalStore.getState().openNewInstanceModal()}
                  className="flex items-start gap-3 w-full p-3.5 rounded-2xl border border-border/50 bg-muted/30 hover:bg-muted/50 hover:border-primary/30 text-left transition-colors cursor-pointer"
                >
                  <EntityAvatar icon={Plus} size="md" className="mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground">{tHardcodedUi.raw('componentsSidebarServerSelector.line1207JsxTextAddCloudInstance')}</p>
                    <p className="text-xs text-muted-foreground/70 mt-0.5">{tHardcodedUi.raw('componentsSidebarServerSelector.line1208JsxTextSelectServerTypeAndLocationForAnAdditional')}</p>
                  </div>
                </button>
              )}

              {isBillingEnabled() && !canAddInstances && (
                <div className="rounded-2xl border border-border/50 bg-muted/20 px-3.5 py-3 text-xs text-muted-foreground/70">{tHardcodedUi.raw('componentsSidebarServerSelector.line1215JsxTextFreePlanConnectACustomInstanceOrUpgrade')}</div>
              )}

              {/* Custom URL */}
              <button
                type="button"
                onClick={() => { setFormUrl(''); setFormLabel(''); setMode('custom'); }}
                disabled={isCreatingSandbox}
                className="flex items-start gap-3 w-full p-3.5 rounded-2xl border border-border/50 bg-muted/30 hover:bg-muted/50 hover:border-primary/30 text-left transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <EntityAvatar icon={Globe} size="md" className="mt-0.5" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground">{tHardcodedUi.raw('componentsSidebarServerSelector.line1228JsxTextCustomUrl')}</p>
                  <p className="text-xs text-muted-foreground/70 mt-0.5">{tHardcodedUi.raw('componentsSidebarServerSelector.line1230JsxTextConnectToAnyKortixInstanceByAddress')}</p>
                </div>
              </button>
            </div>

            {/* Back */}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="self-start text-muted-foreground hover:text-foreground"
              onClick={() => {
                setMode('list');
                setSandboxError(null);
                setSandboxProgress(null);
              }}
            >
              Back
            </Button>
          </div>
        )}

        {/* ──── Custom URL form ──── */}
        {(mode === 'custom' || mode === 'edit') && (
          <form
            onSubmit={(e) => { e.preventDefault(); handleSaveCustom(); }}
            className="flex flex-col gap-4 px-5 pb-5"
          >
            <div className="flex flex-col gap-3">
              {/* URL */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">{tHardcodedUi.raw('componentsSidebarServerSelector.line1263JsxTextInstanceAddress')}</label>
                <Input type="text"
                  ref={urlInputRef}
                  placeholder="http://localhost:8008/v1/p/kortix-sandbox/8000"
                  value={formUrl}
                  onChange={(e) => setFormUrl(e.target.value)}
                  className="h-9 text-sm font-mono"
                  required
                />
                <p className="text-xs text-muted-foreground/50">{tHardcodedUi.raw('componentsSidebarServerSelector.line1274JsxTextTheFullUrlOfTheKortixServerE')}</p>
              </div>

              {/* Label */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">{tHardcodedUi.raw('componentsSidebarServerSelector.line1281JsxTextDisplayName')}<span className="text-muted-foreground/40">(optional)</span>
                </label>
                <Input type="text"
                  placeholder={tHardcodedUi.raw('componentsSidebarServerSelector.line1284JsxAttrPlaceholderMyDevInstance')}
                  value={formLabel}
                  onChange={(e) => setFormLabel(e.target.value)}
                  className="h-9 text-sm"
                />
              </div>
            </div>

            {/* Actions */}
            <div className="flex items-center justify-between pt-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => setMode(mode === 'edit' ? 'list' : 'add')}
              >
                Back
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={!formUrl.trim()}
              >
                {mode === 'custom' ? 'Add & Connect' : 'Save Changes'}
              </Button>
            </div>
          </form>
        )}

        {/* ──── SSH view (cached command only) ──── */}
        {mode === 'ssh' && !sshResult && (
          <div className="flex flex-col px-5 pb-5 gap-4">
            {sshMeta ? (
              <>
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">{tHardcodedUi.raw('componentsSidebarServerSelector.line1320JsxTextReconnectCommand')}</p>
                  <div className="relative">
                    <pre className="max-w-full text-xs font-mono bg-muted/40 border border-border rounded-2xl px-3 py-2.5 pr-16 overflow-x-hidden whitespace-pre-wrap break-all text-foreground">
                      {renderShellHighlighted(sshMeta.ssh_command)}
                    </pre>
                    <Button
                      type="button"
                      onClick={() => copyToClipboard(sshMeta.ssh_command, 'connect')}
                      variant="outline"
                      size="icon-sm"
                      className="absolute top-2.5 right-2.5 z-10"
                      aria-label={tHardcodedUi.raw('componentsSidebarServerSelector.line1331JsxAttrAriaLabelCopyConnectCommand')}
                    >
                      {copiedField === 'connect' ? <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400" /> : <Copy className="h-3 w-3" />}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground/50">{tHardcodedUi.raw('componentsSidebarServerSelector.line1336JsxTextNeedNewKeysRegenerateBelow')}</p>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div className="rounded-2xl border border-border/40 bg-muted/20 px-2.5 py-2">
                    <p className="text-xs uppercase tracking-wider text-muted-foreground/40 mb-0.5">Host</p>
                    <p className="text-xs font-mono text-foreground/80">{sshMeta.host}</p>
                  </div>
                  <div className="rounded-2xl border border-border/40 bg-muted/20 px-2.5 py-2">
                    <p className="text-xs uppercase tracking-wider text-muted-foreground/40 mb-0.5">Port</p>
                    <p className="text-xs font-mono text-foreground/80">{sshMeta.port}</p>
                  </div>
                  <div className="rounded-2xl border border-border/40 bg-muted/20 px-2.5 py-2">
                    <p className="text-xs uppercase tracking-wider text-muted-foreground/40 mb-0.5">User</p>
                    <p className="text-xs font-mono text-foreground/80">{sshMeta.username}</p>
                  </div>
                </div>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">{tHardcodedUi.raw('componentsSidebarServerSelector.line1354JsxTextGenerateSshKeysToGetSetupAndConnect')}</p>
            )}

            <div className="flex items-center pt-1 border-t border-border/30">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => setMode('list')}
              >
                Back
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="text-xs text-muted-foreground hover:text-foreground"
                onClick={handleGenerateSSH}
                disabled={isGeneratingSSH}
              >
                {isGeneratingSSH ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Generate / Regenerate'}
              </Button>
            </div>
          </div>
        )}

        {/* ──── SSH result view ──── */}
        {mode === 'ssh' && sshResult && (
          <div className="flex flex-col min-h-0 flex-1 px-5 pb-5 overflow-y-auto overflow-x-hidden">
            <SSHResultView
              sshResult={sshResult}
              copiedField={copiedField}
              onCopy={copyToClipboard}
              onRegenerate={handleGenerateSSH}
              isGenerating={isGeneratingSSH}
              onDownloadKey={savePrivateKey}
            />
            <div className="flex items-center pt-2 border-t border-border/20">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => setMode('list')}
              >
                Back
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>

    {/* Cancel instance confirm dialog */}
    <AlertDialog open={!!pendingCancelServer} onOpenChange={(o) => { if (!o) setPendingCancelServer(null); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{tHardcodedUi.raw('componentsSidebarServerSelector.line1412JsxTextCancelThisInstance')}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>{tHardcodedUi.raw('componentsSidebarServerSelector.line1415JsxTextYourInstanceStaysActiveUntilTheEndOf')}</p>
              <ul className="list-disc list-inside text-destructive/70 space-y-0.5 text-sm">
                <li>{tHardcodedUi.raw('componentsSidebarServerSelector.line1417JsxTextTheMachineWillBe')}<strong>{tHardcodedUi.raw('componentsSidebarServerSelector.line1417JsxTextPermanentlyShutDown')}</strong></li>
                <li>{tHardcodedUi.raw('componentsSidebarServerSelector.line1418JsxTextAllDataOnTheInstanceWillBe')}<strong>deleted</strong></li>
              </ul>
              <p>{tHardcodedUi.raw('componentsSidebarServerSelector.line1420JsxTextYouCanReactivateAnytimeBeforeThePeriodEnds')}</p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{tHardcodedUi.raw('componentsSidebarServerSelector.line1425JsxTextKeepInstance')}</AlertDialogCancel>
          <AlertDialogAction
            className={buttonVariants({ variant: 'destructive' })}
            onClick={handleCancelConfirmed}
          >{tHardcodedUi.raw('componentsSidebarServerSelector.line1430JsxTextCancelScheduleDeletion')}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
  );
}

// ============================================================================
// ServerSelector - the dropdown inline component
// ============================================================================

export function ServerSelector() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const { servers, activeServerId } = useServerStore();
  const router = useRouter();
  const pathname = usePathname();

  const handleSelect = (id: string) => {
    const result = activateServerSelection(id, { pathname });
    if (!result) return;
    router.push(result.href);
  };

  return (
    <div className="flex flex-col">
      {/* Instance list */}
      <div className="flex flex-col px-1 max-h-[200px] overflow-y-auto">
        {servers.map((server) => (
          <CompactInstanceRow
            key={server.id}
            server={server}
            isActive={server.id === activeServerId}
            onSelect={() => handleSelect(server.id)}
          />
        ))}
      </div>

      {/* Manage */}
      <div className="px-1 pt-1">
        <button
          type="button"
          className="flex items-center gap-1.5 w-full px-2 py-1.5 rounded-lg text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors cursor-pointer"
          onClick={() => router.push('/dashboard')}
        >
          <Settings2 className="size-3" />{tHardcodedUi.raw('componentsSidebarServerSelector.line1476JsxTextOpenDashboard')}</button>
      </div>
    </div>
  );
}

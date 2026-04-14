'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  ArrowDownToLine,
  HardDrive,
  KeyRound,
  Loader2,
  Cpu,
  MemoryStick,
  RotateCw,
  RefreshCw,
  Server,
  Settings2,
  Shield,
  TriangleAlert,
  X,
} from 'lucide-react';
import { toast as sonnerToast } from 'sonner';

import {
  createBackup,
  getLatestSandboxVersion,
  getSSHConnection,
  restartSandbox,
  setupSSH,
  stopSandbox,
  type BackupInfo,
  type SandboxInfo,
  type SSHConnectionInfo,
  type SSHSetupResult,
} from '@/lib/platform-client';
import { hasNewerVersion, InstanceUpdateDialog } from './instance-update-dialog';
import { VersionHistoryPanel } from '@/components/changelog/version-history-panel';
import { useAdminRole } from '@/hooks/admin/use-admin-role';
import { useAdminSandboxAction, useAdminSandboxDetail } from '@/hooks/admin/use-admin-sandboxes';
import { useBackups } from '@/hooks/instance/use-backups';
import { getServerTypes, type ServerType } from '@/lib/api/billing';
import { useIsMobile } from '@/hooks/utils';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

type TabId = 'overview' | 'host' | 'updates' | 'backups';

interface TabDef {
  id: TabId;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  hidden?: boolean;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatDate(date: string | null | undefined): string {
  if (!date) return '—';
  return new Date(date).toLocaleString();
}

function CopyField({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1.5">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <button
        type="button"
        onClick={() => navigator.clipboard.writeText(value)}
        className="w-full text-left rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs font-mono break-all hover:bg-muted/40 transition-colors"
      >
        {value}
      </button>
    </div>
  );
}

function CommandCopyField({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success(`${label} copied`, {
        description: 'The full command was copied to your clipboard.',
      });
      window.setTimeout(() => setCopied(false), 1500);
    } catch (error) {
      toast.error(`Failed to copy ${label.toLowerCase()}`, {
        description: error instanceof Error ? error.message : 'Clipboard write failed.',
      });
    }
  }

  return (
    <div className="space-y-1.5">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <button
        type="button"
        onClick={handleCopy}
        className={cn(
          'w-full text-left rounded-lg border px-3 py-3 text-xs transition-all',
          copied
            ? 'border-emerald-500/40 bg-emerald-500/10'
            : 'border-border/60 bg-muted/20 hover:bg-muted/40 hover:border-border',
        )}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="font-medium text-foreground">{copied ? 'Copied' : 'Click to copy'}</div>
          <div className={cn(
            'text-[10px] px-2 py-0.5 rounded-full border transition-colors',
            copied
              ? 'border-emerald-500/40 text-emerald-300 bg-emerald-500/10'
              : 'border-border/60 text-muted-foreground bg-background/60',
          )}>
            {copied ? 'Copied' : '1-click copy'}
          </div>
        </div>
        <div className="text-muted-foreground mt-1.5 text-[11px] leading-relaxed">
          {hint || 'Command hidden for security. The full command is copied to your clipboard.'}
        </div>
      </button>
    </div>
  );
}

function BackupRow({
  backup,
  onRestore,
  onDelete,
  restoring,
  deleting,
}: {
  backup: BackupInfo;
  onRestore: () => void;
  onDelete: () => void;
  restoring: boolean;
  deleting: boolean;
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-muted/10 px-4 py-3 flex items-center gap-3">
      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted/50">
        <HardDrive className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium truncate">{backup.description || `Backup ${backup.id}`}</div>
        <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
          <span>{formatDate(backup.created)}</span>
          <span>·</span>
          <span>{formatBytes(backup.size)}</span>
          <span>·</span>
          <span className="uppercase tracking-wide">{backup.status}</span>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={onRestore} disabled={restoring || deleting}>
          {restoring ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Restore'}
        </Button>
        <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={onDelete} disabled={restoring || deleting}>
          {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Delete'}
        </Button>
      </div>
    </div>
  );
}

function HealthBar({
  label,
  pct,
  icon: Icon,
  detail,
}: {
  label: string;
  pct: number | undefined;
  icon: React.ComponentType<{ className?: string }>;
  detail?: string;
}) {
  const raw = typeof pct === 'number' ? pct : null;
  const value = raw === null ? null : Math.max(0, Math.min(100, raw <= 1 ? raw * 100 : raw));
  const color = value === null ? '' : value >= 90 ? 'bg-red-500' : value >= 75 ? 'bg-amber-500' : 'bg-emerald-500';

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="flex items-center gap-1.5 text-muted-foreground"><Icon className="h-3 w-3" /> {label}</span>
        <span className="font-mono tabular-nums">{value === null ? '—' : `${value.toFixed(0)}%`}</span>
      </div>
      <div className="h-1.5 bg-foreground/[0.06] rounded-full overflow-hidden">
        {value !== null && <div className={cn('h-full transition-all', color)} style={{ width: `${value}%` }} />}
      </div>
      {detail ? <div className="text-[11px] text-muted-foreground">{detail}</div> : null}
    </div>
  );
}

export function InstanceSettingsModal({
  sandbox,
  open,
  onOpenChange,
}: {
  sandbox: SandboxInfo | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const isMobile = useIsMobile();
  const { data: adminRole } = useAdminRole();
  const isAdmin = !!adminRole?.isAdmin;
  const [activeTab, setActiveTab] = useState<TabId>('overview');
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
  const [restartConfirmOpen, setRestartConfirmOpen] = useState(false);
  const [backupDescription, setBackupDescription] = useState('');
  const [restoreTarget, setRestoreTarget] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [setupResult, setSetupResult] = useState<SSHSetupResult | null>(null);

  const isJustAVPS = sandbox?.provider === 'justavps';
  const supportsBackups = !!sandbox && isJustAVPS && ['active', 'stopped'].includes(sandbox.status);
  const supportsUpdates = !!sandbox && isJustAVPS && ['active', 'stopped', 'error'].includes(sandbox.status);
  const actionable = !!sandbox && ['active', 'stopped', 'error'].includes(sandbox.status);

  const adminDetailQuery = useAdminSandboxDetail(open && isAdmin && sandbox?.sandbox_id ? sandbox.sandbox_id : null);
  const adminActionMutation = useAdminSandboxAction();
  const adminDetail = adminDetailQuery.data;
  const providerDetail = adminDetail?.provider_detail;
  const effectiveStatus = providerDetail?.status ?? sandbox?.status ?? null;
  const effectiveIp = providerDetail?.ip ?? null;
  const effectiveRegion = providerDetail?.region ?? null;
  const effectiveServerType = providerDetail?.server_type ?? ((sandbox?.metadata as Record<string, unknown> | undefined)?.serverType as string | undefined) ?? null;
  const adminSshCommand = providerDetail?.ssh?.command ?? providerDetail?.connect?.ssh_command ?? null;
  const adminSetupCommand = providerDetail?.ssh?.setup_command ?? providerDetail?.connect?.setup_command ?? providerDetail?.ssh_key?.setup_command ?? null;
  const serverTypesQuery = useQuery({
    queryKey: ['server-types', effectiveRegion || 'default'],
    queryFn: () => getServerTypes(effectiveRegion || undefined),
    enabled: open && activeTab === 'host' && !!effectiveServerType && isJustAVPS,
    staleTime: 5 * 60 * 1000,
  });
  const matchedServerType: ServerType | null =
    serverTypesQuery.data?.serverTypes.find((type) => type.name === effectiveServerType) ?? null;
  const cpuPercent = typeof providerDetail?.health?.cpu === 'number' ? (providerDetail.health.cpu <= 1 ? providerDetail.health.cpu * 100 : providerDetail.health.cpu) : null;
  const memoryPercent = typeof providerDetail?.health?.memory === 'number' ? (providerDetail.health.memory <= 1 ? providerDetail.health.memory * 100 : providerDetail.health.memory) : null;
  const diskPercent = typeof providerDetail?.health?.disk === 'number' ? (providerDetail.health.disk <= 1 ? providerDetail.health.disk * 100 : providerDetail.health.disk) : null;

  function formatCapacityDetail(percent: number | null, total: number | null, unit: string, label: string) {
    if (percent === null || total === null) return total !== null ? `${total} ${unit} total` : undefined;
    const used = (total * percent) / 100;
    const available = Math.max(total - used, 0);
    const fmt = (n: number) => Number.isInteger(n) ? String(n) : n.toFixed(1);
    return `${fmt(available)} ${unit} free of ${fmt(total)} ${unit} ${label}`;
  }

  const tabs = useMemo<TabDef[]>(() => [
    { id: 'overview', label: 'General', icon: Settings2 },
    { id: 'host', label: 'Host', icon: Server },
    { id: 'updates', label: 'Updates', icon: ArrowDownToLine, hidden: !supportsUpdates },
    { id: 'backups', label: 'Backups', icon: Archive, hidden: !supportsBackups },
  ], [supportsBackups, supportsUpdates]);

  const visibleTabs = tabs.filter((tab) => !tab.hidden);

  useEffect(() => {
    if (!open) {
      setActiveTab('overview');
      setSetupResult(null);
      setBackupDescription('');
      setRestoreTarget(null);
      setDeleteTarget(null);
      setUpdateDialogOpen(false);
      setRestartConfirmOpen(false);
    }
  }, [open]);

  useEffect(() => {
    if (!visibleTabs.some((tab) => tab.id === activeTab)) {
      setActiveTab('overview');
    }
  }, [activeTab, visibleTabs]);

  const sshQuery = useQuery<SSHConnectionInfo>({
    queryKey: ['instance', 'ssh', sandbox?.sandbox_id],
    queryFn: () => getSSHConnection(sandbox!.sandbox_id),
    enabled: open && activeTab === 'host' && !!sandbox && !isAdmin,
    staleTime: 30_000,
  });

  const latestVersionQuery = useQuery({
    queryKey: ['instance', 'latest-version', sandbox?.sandbox_id],
    queryFn: () => getLatestSandboxVersion((sandbox?.version || '').startsWith('dev-') ? 'dev' : 'stable'),
    enabled: open && activeTab === 'updates' && !!sandbox && supportsUpdates,
    staleTime: 5 * 60 * 1000,
  });

  const backups = useBackups(sandbox?.sandbox_id);

  const restartMutation = useMutation({
    mutationFn: () => restartSandbox(sandbox!.sandbox_id),
    onSuccess: () => {
      sonnerToast.success('Instance restarted');
      queryClient.invalidateQueries({ queryKey: ['platform', 'sandbox', 'list'] });
      setRestartConfirmOpen(false);
    },
    onError: (error) => {
      sonnerToast.error(error instanceof Error ? error.message : 'Failed to restart instance');
    },
  });

  const stopMutation = useMutation({
    mutationFn: () => stopSandbox(sandbox!.sandbox_id),
    onSuccess: () => {
      sonnerToast.success('Host stopped');
      queryClient.invalidateQueries({ queryKey: ['platform', 'sandbox', 'list'] });
    },
    onError: (error) => {
      sonnerToast.error(error instanceof Error ? error.message : 'Failed to stop host');
    },
  });

  const hostActionPending = restartMutation.isPending || stopMutation.isPending || adminActionMutation.isPending;

  function triggerHostAction(action: 'start' | 'stop' | 'reboot') {
    if (!sandbox) return;
    if (isAdmin) {
      adminActionMutation.mutate(
        { sandboxId: sandbox.sandbox_id, action },
        {
          onSuccess: () => {
            sonnerToast.success(`${action === 'reboot' ? 'Host reboot' : action === 'start' ? 'Host start' : 'Host stop'} initiated`);
            queryClient.invalidateQueries({ queryKey: ['platform', 'sandbox', 'list'] });
            adminDetailQuery.refetch();
            setRestartConfirmOpen(false);
          },
          onError: (error) => {
            sonnerToast.error(error instanceof Error ? error.message : `Failed to ${action} host`);
          },
        },
      );
      return;
    }

    if (action === 'stop') {
      stopMutation.mutate();
      return;
    }

    restartMutation.mutate();
  }

  const setupSshMutation = useMutation({
    mutationFn: () => setupSSH(sandbox!.sandbox_id),
    onSuccess: (result) => {
      setSetupResult(result);
      sonnerToast.success('SSH key generated');
      sshQuery.refetch();
    },
    onError: (error) => {
      sonnerToast.error(error instanceof Error ? error.message : 'Failed to set up SSH');
    },
  });

  async function handleCreateBackup() {
    if (!sandbox) return;
    try {
      await backups.create.mutateAsync(backupDescription || undefined);
      setBackupDescription('');
      sonnerToast.success('Backup started');
    } catch (error) {
      sonnerToast.error(error instanceof Error ? error.message : 'Failed to create backup');
    }
  }

  async function handleRestoreBackup() {
    if (!restoreTarget) return;
    try {
      await backups.restore.mutateAsync(restoreTarget);
      sonnerToast.success('Restore initiated');
      setRestoreTarget(null);
    } catch (error) {
      sonnerToast.error(error instanceof Error ? error.message : 'Failed to restore backup');
    }
  }

  async function handleDeleteBackup() {
    if (!deleteTarget) return;
    try {
      await backups.remove.mutateAsync(deleteTarget);
      sonnerToast.success('Backup deleted');
      setDeleteTarget(null);
    } catch (error) {
      sonnerToast.error(error instanceof Error ? error.message : 'Failed to delete backup');
    }
  }

  const latestVersion = latestVersionQuery.data?.version ?? null;
  const updateAvailable = sandbox?.version && latestVersion ? hasNewerVersion(sandbox.version, latestVersion) : false;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className={cn(
            'p-0 gap-0',
            isMobile
              ? 'fixed inset-0 w-screen h-screen max-w-none max-h-none rounded-none m-0 translate-x-0 translate-y-0 left-0 top-0'
              : 'max-w-5xl max-h-[90vh] overflow-hidden',
          )}
          hideCloseButton
        >
          <DialogTitle className="sr-only">Instance settings</DialogTitle>

          {isMobile ? (
            <div className="flex flex-col h-screen w-screen overflow-hidden">
              <div className="px-4 py-3 border-b border-border flex items-center justify-between bg-background">
                <div>
                  <div className="text-lg font-semibold">Instance settings</div>
                  <div className="text-xs text-muted-foreground truncate max-w-[70vw]">
                    {sandbox?.name || sandbox?.sandbox_id || 'No instance selected'}
                  </div>
                </div>
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => onOpenChange(false)}>
                  <X className="h-4 w-4" />
                </Button>
              </div>

              <div className="px-3 py-2.5 border-b border-border bg-background">
                <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-3 px-3 scrollbar-none [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
                  {visibleTabs.map((tab) => {
                    const Icon = tab.icon;
                    return (
                      <Button
                        key={tab.id}
                        onClick={() => setActiveTab(tab.id)}
                        variant={activeTab === tab.id ? 'secondary' : 'ghost'}
                        className="flex items-center gap-2 whitespace-nowrap flex-shrink-0 justify-start"
                      >
                        <Icon className="h-4 w-4" />
                        <span>{tab.label}</span>
                      </Button>
                    );
                  })}
                </div>
              </div>

              <div className="flex-1 overflow-y-auto bg-background">{renderContent()}</div>

              {sandbox ? (
                <div className="border-t border-border bg-background/95 px-4 py-3 flex justify-end">
                  <Button onClick={() => router.push(`/instances/${sandbox.sandbox_id}`)}>
                    Open instance
                  </Button>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="flex flex-row h-[700px]">
              <div className="bg-background flex-shrink-0 w-56 p-4 border-r border-border">
                <div className="flex justify-start mb-3">
                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => onOpenChange(false)}>
                    <X className="h-4 w-4" />
                  </Button>
                </div>

                <div className="px-4 pb-3">
                  <div className="text-sm font-semibold truncate">{sandbox?.name || 'Instance settings'}</div>
                  <div className="text-[11px] text-muted-foreground font-mono truncate mt-1">
                    {sandbox?.sandbox_id || '—'}
                  </div>
                </div>

                <div className="flex flex-col gap-0.5">
                  {visibleTabs.map((tab) => {
                    const Icon = tab.icon;
                    const isActive = activeTab === tab.id;
                    return (
                      <Button
                        key={tab.id}
                        onClick={() => setActiveTab(tab.id)}
                        variant="ghost"
                        className={cn(
                          'w-full flex items-center gap-3 justify-start',
                          isActive ? 'bg-accent text-foreground hover:bg-accent' : 'text-muted-foreground hover:text-foreground',
                        )}
                      >
                        <Icon className="h-4 w-4 flex-shrink-0" />
                        <span>{tab.label}</span>
                      </Button>
                    );
                  })}
                </div>
              </div>

              <div className="flex-1 min-h-0 w-full max-w-full bg-background flex flex-col">
                <div className="flex-1 overflow-y-auto min-h-0">{renderContent()}</div>
                {sandbox ? (
                  <div className="border-t border-border bg-background/95 px-4 py-3 flex justify-end">
                    <Button onClick={() => router.push(`/instances/${sandbox.sandbox_id}`)}>
                      Open instance
                    </Button>
                  </div>
                ) : null}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={restartConfirmOpen}
        onOpenChange={setRestartConfirmOpen}
        title={effectiveStatus === 'stopped' ? 'Start this host?' : 'Reboot this host?'}
        description={
          <>
            This will {effectiveStatus === 'stopped' ? 'start' : 'reboot'}{' '}
            <span className="font-medium text-foreground">{sandbox?.name || sandbox?.sandbox_id || 'this instance'}</span>.
            {effectiveStatus === 'stopped' ? ' The host will boot back up.' : ' Any unsaved in-memory state will be lost.'}
          </>
        }
        confirmLabel={effectiveStatus === 'stopped' ? 'Start host' : 'Reboot host'}
        onConfirm={() => triggerHostAction(effectiveStatus === 'stopped' ? 'start' : 'reboot')}
        isPending={hostActionPending}
      />

      <ConfirmDialog
        open={!!restoreTarget}
        onOpenChange={(open) => !open && setRestoreTarget(null)}
        title="Restore this backup?"
        description="Your current instance state will be replaced with the selected backup. This cannot be undone."
        confirmLabel="Restore"
        onConfirm={handleRestoreBackup}
        isPending={backups.restore.isPending}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="Delete this backup?"
        description="This backup will be permanently removed."
        confirmLabel="Delete"
        onConfirm={handleDeleteBackup}
        isPending={backups.remove.isPending}
      />

      <InstanceUpdateDialog
        sandbox={sandbox}
        open={updateDialogOpen}
        onClose={() => setUpdateDialogOpen(false)}
        onCompleted={() => {
          queryClient.invalidateQueries({ queryKey: ['platform', 'sandbox', 'list'] });
        }}
      />
    </>
  );

  function renderContent() {
    if (!sandbox) {
      return <div className="p-6 text-sm text-muted-foreground">No instance selected.</div>;
    }

    if (activeTab === 'overview') {
      const meta = sandbox.metadata as Record<string, unknown> | undefined;
      return (
        <div className="p-6 space-y-6">
          <section className="space-y-3">
            <div>
              <h2 className="text-lg font-semibold">General</h2>
              <p className="text-sm text-muted-foreground">Core details and entry points for this instance.</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl border border-border/60 bg-muted/10 p-4 space-y-1.5">
                <div className="text-xs text-muted-foreground">Name</div>
                <div className="font-medium">{sandbox.name || 'Untitled instance'}</div>
              </div>
              <div className="rounded-xl border border-border/60 bg-muted/10 p-4 space-y-1.5">
                <div className="text-xs text-muted-foreground">Status</div>
                <div className="font-medium capitalize">{sandbox.status}</div>
              </div>
              <div className="rounded-xl border border-border/60 bg-muted/10 p-4 space-y-1.5">
                <div className="text-xs text-muted-foreground">Provider</div>
                <div className="font-medium capitalize">{sandbox.provider}</div>
              </div>
              <div className="rounded-xl border border-border/60 bg-muted/10 p-4 space-y-1.5">
                <div className="text-xs text-muted-foreground">Version</div>
                <div className="font-medium font-mono">{sandbox.version || '—'}</div>
              </div>
              <div className="rounded-xl border border-border/60 bg-muted/10 p-4 space-y-1.5">
                <div className="text-xs text-muted-foreground">Location</div>
                <div className="font-medium">{(meta?.location as string) || '—'}</div>
              </div>
              <div className="rounded-xl border border-border/60 bg-muted/10 p-4 space-y-1.5">
                <div className="text-xs text-muted-foreground">Server type</div>
                <div className="font-medium font-mono">{(meta?.serverType as string) || '—'}</div>
              </div>
            </div>
          </section>

          <section className="rounded-xl border border-border/60 bg-muted/10 p-4 space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Server className="h-4 w-4 text-muted-foreground" />
              Quick actions
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => queryClient.invalidateQueries({ queryKey: ['platform', 'sandbox', 'list'] })}>
                Reload details
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Use the Host tab for machine-level access and power actions.
            </p>
          </section>
        </div>
      );
    }

    if (activeTab === 'host') {
      return (
        <div className="p-6 space-y-6">
          <div>
            <h2 className="text-lg font-semibold">Host</h2>
            <p className="text-sm text-muted-foreground">Access and host-level power controls for this instance.</p>
          </div>

          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 flex items-start gap-3">
            <TriangleAlert className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
            <div>
              <div className="text-sm font-medium text-foreground">This tab controls the host machine</div>
              <div className="text-xs text-muted-foreground mt-1">
                Start, stop, reboot, and SSH actions here affect the actual host backing this instance.
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-border/60 bg-muted/10 p-4 space-y-3">
            <div className="text-sm font-medium">Host actions</div>
            <div className="flex flex-wrap gap-2">
              {actionable && (
                <Button variant="outline" onClick={() => setRestartConfirmOpen(true)} disabled={hostActionPending}>
                  {hostActionPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <RotateCw className="h-4 w-4 mr-2" />}
                  {effectiveStatus === 'stopped' ? 'Start host' : 'Reboot host'}
                </Button>
              )}
              <Button variant="outline" onClick={() => triggerHostAction('stop')} disabled={effectiveStatus === 'stopped' || hostActionPending}>
                {hostActionPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                Stop host
              </Button>
              <Button variant="ghost" onClick={() => adminDetailQuery.refetch()} disabled={adminDetailQuery.isFetching}>
                <RefreshCw className={cn('h-4 w-4 mr-2', adminDetailQuery.isFetching ? 'animate-spin' : '')} />
                Refresh host
              </Button>
            </div>
          </div>

          <div className="space-y-4">
              {isAdmin && adminDetailQuery.isLoading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Resolving host access details…
                </div>
              ) : isAdmin && (adminSshCommand || adminSetupCommand) ? (
                <div className="space-y-4">
                  {adminSshCommand ? <CommandCopyField label="SSH command" value={adminSshCommand} hint="Copies the direct SSH command without exposing it on screen." /> : null}
                  {adminSetupCommand ? <CommandCopyField label="Setup command" value={adminSetupCommand} hint="Copies the full setup command, including any hidden key material." /> : null}
                  {(effectiveIp || effectiveRegion || effectiveServerType) && (
                    <div className="rounded-xl border border-border/60 bg-muted/10 p-4 space-y-2">
                      <div className="text-xs text-muted-foreground">Host details</div>
                      {effectiveIp ? <div className="text-sm font-mono">IP: {effectiveIp}</div> : null}
                      {effectiveRegion ? <div className="text-sm">Region: {effectiveRegion}</div> : null}
                      {effectiveServerType ? <div className="text-sm font-mono">Server type: {effectiveServerType}</div> : null}
                    </div>
                  )}
                </div>
              ) : sshQuery.isLoading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Resolving connection details…
                </div>
              ) : sshQuery.error ? (
                <div className="rounded-xl border border-border/60 bg-muted/10 p-4 space-y-3">
                  <div className="text-sm text-muted-foreground">SSH is not configured for this instance yet.</div>
                  <Button onClick={() => setupSshMutation.mutate()} disabled={setupSshMutation.isPending}>
                    {setupSshMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <KeyRound className="h-4 w-4 mr-2" />}
                    Set up SSH
                  </Button>
                </div>
              ) : sshQuery.data ? (
                <div className="space-y-4">
                  <CommandCopyField label="SSH command" value={setupResult?.ssh_command || sshQuery.data.ssh_command} hint="Copies the SSH command without exposing the full host command inline." />
                  <CommandCopyField label="Reconnect command" value={setupResult?.reconnect_command || sshQuery.data.reconnect_command} hint="Copies the reconnect command for future sessions." />
                  <CommandCopyField label="SSH config command" value={setupResult?.ssh_config_command || sshQuery.data.ssh_config_command} hint="Copies the SSH config snippet command for your local machine." />
                  <div className="rounded-xl border border-border/60 bg-muted/10 p-4 space-y-2">
                    <div className="text-xs text-muted-foreground">Connection details</div>
                    <div className="text-sm">{sshQuery.data.username}@{sshQuery.data.host}:{sshQuery.data.port}</div>
                    <div className="text-xs text-muted-foreground font-mono">Host alias: {sshQuery.data.host_alias}</div>
                  </div>
                  {!setupResult && (
                    <Button variant="outline" onClick={() => setupSshMutation.mutate()} disabled={setupSshMutation.isPending}>
                      {setupSshMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Shield className="h-4 w-4 mr-2" />}
                      Regenerate SSH setup
                    </Button>
                  )}
                  {setupResult && <CommandCopyField label="Setup command" value={setupResult.setup_command} hint="Copies the full setup command, including any hidden key material." />}
                </div>
              ) : null}

              {providerDetail?.health ? (
                <div className="rounded-xl border border-border/60 bg-muted/10 p-4 space-y-4">
                  <div className="text-sm font-medium">Resource usage</div>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <HealthBar label="CPU" pct={providerDetail.health.cpu} icon={Cpu} detail={matchedServerType ? formatCapacityDetail(cpuPercent, matchedServerType.cores, 'vCPU', 'total') : undefined} />
                    <HealthBar label="Memory" pct={providerDetail.health.memory} icon={MemoryStick} detail={matchedServerType ? formatCapacityDetail(memoryPercent, matchedServerType.memory, 'GB', 'RAM') : undefined} />
                    <HealthBar label="Disk" pct={providerDetail.health.disk} icon={HardDrive} detail={matchedServerType ? formatCapacityDetail(diskPercent, matchedServerType.disk, 'GB', 'SSD') : undefined} />
                  </div>
                </div>
              ) : null}

              <div className="rounded-xl border border-border/60 bg-muted/10 p-4 space-y-3">
                <div className="text-sm font-medium">Host details</div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <div className="text-xs text-muted-foreground">Status</div>
                    <div className="text-sm font-medium capitalize">{effectiveStatus || '—'}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">IP address</div>
                    <div className="text-sm font-medium font-mono">{effectiveIp || '—'}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">Region</div>
                    <div className="text-sm font-medium">{effectiveRegion || '—'}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">Server type</div>
                    <div className="text-sm font-medium font-mono">{effectiveServerType || '—'}</div>
                  </div>
                </div>
              </div>

              <div className="rounded-xl border border-border/60 bg-muted/10 p-4 space-y-3">
                <div className="text-sm font-medium">Deep debugging</div>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  If you SSH into the host machine itself, you can inspect the running Kortix container directly. Typical flow: run <span className="font-mono text-foreground">docker ps</span>, identify the <span className="font-mono text-foreground">kortix/computer</span> container or <span className="font-mono text-foreground">justavps-workload</span> name, then exec into it for full root access inside the container.
                </p>
                <div className="grid gap-3 md:grid-cols-2">
                  <CopyField label="List running containers" value="docker ps" />
                  <CopyField label="Open running Kortix container" value="docker exec -it justavps-workload bash" />
                </div>
                <div className="rounded-lg border border-border/60 bg-background/60 px-3 py-2 text-[11px] text-muted-foreground">
                  Inside the container, you can inspect <span className="font-mono text-foreground">/workspace</span>, verify runtime state, and debug the live Kortix environment directly.
                </div>
              </div>
          </div>
        </div>
      );
    }

    if (activeTab === 'updates') {
      return (
        <div className="p-6 space-y-6">
          <div>
            <h2 className="text-lg font-semibold">Updates</h2>
            <p className="text-sm text-muted-foreground">Check the latest available version and open the updater flow.</p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-border/60 bg-muted/10 p-4 space-y-1.5">
              <div className="text-xs text-muted-foreground">Current version</div>
              <div className="font-medium font-mono">{sandbox.version || 'Unknown'}</div>
            </div>
            <div className="rounded-xl border border-border/60 bg-muted/10 p-4 space-y-1.5">
              <div className="text-xs text-muted-foreground">Latest version</div>
              <div className="font-medium font-mono">
                {latestVersionQuery.isLoading ? 'Checking…' : latestVersion || 'Unavailable'}
              </div>
            </div>
          </div>

          <VersionHistoryPanel
            currentVersion={sandbox.version || null}
            latestVersion={latestVersion}
            updateAvailable={updateAvailable}
            isUpdating={false}
            onUpdateLatest={() => setUpdateDialogOpen(true)}
            initialShowDev={(sandbox.version || '').startsWith('dev-')}
            compact
            headerTitle="Versions"
            headerDescription="Same full changelog/version history content as the main changelog page."
          />
        </div>
      );
    }

    return (
      <div className="p-6 space-y-6">
        <div>
          <h2 className="text-lg font-semibold">Backups</h2>
          <p className="text-sm text-muted-foreground">Create, restore, and delete instance backups.</p>
          <p className="text-xs text-muted-foreground mt-2">
            Backups are created automatically every day, retained for up to 7 days, and a fresh backup is automatically created before any update runs.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Input
            value={backupDescription}
            onChange={(e) => setBackupDescription(e.target.value)}
            placeholder="Backup description (optional)"
          />
          <Button onClick={handleCreateBackup} disabled={backups.create.isPending}>
            {backups.create.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Archive className="h-4 w-4 mr-2" />}
            Backup now
          </Button>
        </div>

        {backups.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading backups…
          </div>
        ) : backups.backups.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border/60 bg-muted/10 p-8 text-center text-sm text-muted-foreground">
            No backups yet.
          </div>
        ) : (
          <div className="space-y-2">
            {backups.backups.map((backup) => (
              <BackupRow
                key={backup.id}
                backup={backup}
                onRestore={() => setRestoreTarget(backup.id)}
                onDelete={() => setDeleteTarget(backup.id)}
                restoring={backups.restore.isPending && backups.restore.variables === backup.id}
                deleting={backups.remove.isPending && backups.remove.variables === backup.id}
              />
            ))}
          </div>
        )}
      </div>
    );
  }
}

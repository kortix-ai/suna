'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  Archive,
  ArrowDownToLine,
  Copy,
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
  WifiOff,
  X,
} from 'lucide-react';
import { toast as sonnerToast } from 'sonner';

import {
  getSandboxUrl,
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
import { useAdminSandboxAction, useAdminSandboxDetail, useAdminSandboxHealth, useAdminSandboxRepair, type AdminInstanceLayerAction, type AdminInstanceLayerHealth } from '@/hooks/admin/use-admin-sandboxes';
import { useBackups } from '@/hooks/instance/use-backups';
import { getServerTypes, type ServerType } from '@/lib/api/billing';
import { authenticatedFetch } from '@/lib/auth-token';
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

interface SandboxConfigProblem {
  source: string;
  scope: 'global' | 'local' | 'env' | 'managed' | 'remote' | string;
  kind: 'json' | 'schema' | 'substitution' | string;
  message?: string;
  issues?: Array<{ message?: string }>;
}

interface SandboxConfigStatus {
  valid: boolean;
  loadedSources: string[];
  skippedSources: string[];
  problems: SandboxConfigProblem[];
}

interface SandboxProjectSummary {
  id: string;
  name: string;
  path: string;
}

function isSandboxConfigStatus(value: unknown): value is SandboxConfigStatus {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.valid === 'boolean'
    && Array.isArray(candidate.loadedSources)
    && Array.isArray(candidate.skippedSources)
    && Array.isArray(candidate.problems);
}

async function requestSandboxJson<T>(sandboxUrl: string, path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await authenticatedFetch(`${sandboxUrl.replace(/\/+$/, '')}${path}`, {
      signal: AbortSignal.timeout(10_000),
      ...init,
    }, { retryOnAuthError: false });
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(error.message || 'Request timed out');
    }
    throw new Error('Request timed out');
  }

  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    const message = typeof data === 'object' && data && 'error' in data
      ? String((data as Record<string, unknown>).error)
      : `Request failed with status ${response.status}`;
    throw new Error(message);
  }

  return data as T;
}

function formatProblemLabel(problem: SandboxConfigProblem): string {
  return `${problem.scope} · ${problem.kind}`;
}

function buildConfigFixPrompt(sandbox: SandboxInfo, status: SandboxConfigStatus): string {
  const header = `Inspect and repair the ignored OpenCode config sources for instance "${sandbox.name || sandbox.sandbox_id}".`;
  const explanation = 'OpenCode is running in fail-soft mode and skipped the invalid sources below instead of crashing the runtime.';
  const problems = status.problems.map((problem, index) => {
    const issueLines = (problem.issues ?? []).map((issue) => issue.message).filter(Boolean);
    return [
      `${index + 1}. Source: ${problem.source}`,
      `   Scope: ${problem.scope}`,
      `   Kind: ${problem.kind}`,
      `   Message: ${problem.message || 'No message provided.'}`,
      ...(issueLines.length ? issueLines.map((line) => `   Detail: ${line}`) : []),
    ].join('\n');
  }).join('\n\n');

  return [
    header,
    explanation,
    '',
    problems,
    '',
    'Repair the invalid source in place. If the problem is a legacy top-level `models` array, migrate it to valid `provider` config.',
    'When finished, verify `GET /config/status` returns `{"valid": true, "skippedSources": []}` and the runtime stays healthy.',
  ].join('\n');
}

function getConfigFixTaskTitle(status: SandboxConfigStatus): string {
  return status.problems.length > 1
    ? 'Fix ignored OpenCode config sources'
    : 'Fix ignored OpenCode config source';
}

function pickConfigFixProject(projects: SandboxProjectSummary[]): SandboxProjectSummary | null {
  return projects.find((project) => project.path === '/workspace') ?? projects[0] ?? null;
}

function ConfigDegradationPanel({
  status,
  loading,
  error,
  onCopyPrompt,
  onStartTask,
  taskPending,
  taskTargetLabel,
}: {
  status?: SandboxConfigStatus;
  loading: boolean;
  error?: string | null;
  onCopyPrompt: () => void;
  onStartTask: () => void;
  taskPending: boolean;
  taskTargetLabel?: string | null;
}) {
  if (loading) {
    return (
      <div className="rounded-xl border border-border/60 bg-muted/10 p-4 flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading config diagnostics…
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-border/60 bg-muted/10 p-4 space-y-2">
        <div className="text-sm font-medium">Config diagnostics unavailable</div>
        <div className="text-xs text-muted-foreground break-words">{error}</div>
      </div>
    );
  }

  if (!status || status.valid || status.problems.length === 0) return null;

  return (
    <section className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 space-y-4">
      <div className="flex items-start gap-3">
        <AlertCircle className="mt-0.5 h-4 w-4 text-amber-400 shrink-0" />
        <div className="min-w-0 space-y-1">
          <div className="text-sm font-medium text-foreground">Config degraded — runtime still healthy</div>
          <div className="text-xs text-muted-foreground">
            OpenCode ignored {status.problems.length} invalid config source{status.problems.length === 1 ? '' : 's'} so the workspace stays online.
            Fix the skipped source{status.problems.length === 1 ? '' : 's'} to restore a clean config state.
          </div>
        </div>
      </div>

      <div className="space-y-3">
        {status.problems.map((problem, index) => (
          <div key={`${problem.source}-${index}`} className="rounded-lg border border-amber-500/20 bg-background/70 px-3 py-3 space-y-2">
            <div className="flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-wide text-muted-foreground">
              <span>{formatProblemLabel(problem)}</span>
              <span className="rounded-full border border-border/60 px-2 py-0.5 font-mono normal-case tracking-normal text-foreground/80">{problem.source}</span>
            </div>
            <div className="text-sm text-foreground">{problem.message || 'Unknown config problem.'}</div>
            {problem.issues && problem.issues.length > 0 ? (
              <ul className="space-y-1 text-xs text-muted-foreground list-disc pl-4">
                {problem.issues.slice(0, 3).map((issue, issueIndex) => (
                  <li key={`${problem.source}-issue-${issueIndex}`}>{issue.message || 'Unknown issue'}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={onCopyPrompt}>
          <Copy className="h-3.5 w-3.5 mr-2" />
          Copy fix prompt
        </Button>
        <Button size="sm" onClick={onStartTask} disabled={taskPending}>
          {taskPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-2" /> : <Cpu className="h-3.5 w-3.5 mr-2" />}
          Start fix task
        </Button>
      </div>

      <div className="text-[11px] text-muted-foreground">
        {taskTargetLabel
          ? `The fix task will be created and started in ${taskTargetLabel}.`
          : 'If this instance has no project yet, Kortix will create a Workspace project automatically before starting the fix task.'}
      </div>
    </section>
  );
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
  defaultTab = 'overview',
}: {
  sandbox: SandboxInfo | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultTab?: TabId;
}) {
  const queryClient = useQueryClient();
  const isMobile = useIsMobile();
  const { data: adminRole } = useAdminRole();
  const isAdmin = !!adminRole?.isAdmin;
  const [activeTab, setActiveTab] = useState<TabId>(defaultTab);
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
  const [backupDescription, setBackupDescription] = useState('');
  const [restoreTarget, setRestoreTarget] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [setupResult, setSetupResult] = useState<SSHSetupResult | null>(null);

  const isJustAVPS = sandbox?.provider === 'justavps';
  const supportsBackups = !!sandbox && isJustAVPS && ['active', 'stopped'].includes(sandbox.status);
  const supportsUpdates = !!sandbox && isJustAVPS && ['active', 'stopped', 'error'].includes(sandbox.status);

  const adminDetailQuery = useAdminSandboxDetail(open && isAdmin && sandbox?.sandbox_id ? sandbox.sandbox_id : null);
  const adminHealthQuery = useAdminSandboxHealth(open && isAdmin && sandbox?.sandbox_id ? sandbox.sandbox_id : null, open && !!sandbox && isAdmin && isJustAVPS);
  const adminActionMutation = useAdminSandboxAction();
  const adminRepairMutation = useAdminSandboxRepair();
  const adminDetail = adminDetailQuery.data;
  const adminHealth = adminHealthQuery.data;
  const providerDetail = adminDetail?.provider_detail;
  const providerError = adminDetail?.provider_error ?? null;
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
    { id: 'host', label: 'Health', icon: Server },
    { id: 'updates', label: 'Updates', icon: ArrowDownToLine, hidden: !supportsUpdates },
    { id: 'backups', label: 'Backups', icon: Archive, hidden: !supportsBackups },
  ], [supportsBackups, supportsUpdates]);

  const visibleTabs = tabs.filter((tab) => !tab.hidden);
  const sandboxUrl = useMemo(() => {
    if (!sandbox) return null;
    try {
      return getSandboxUrl(sandbox);
    } catch {
      return null;
    }
  }, [sandbox]);

  const configStatusQuery = useQuery<SandboxConfigStatus>({
    queryKey: ['sandbox', 'config-status', sandbox?.sandbox_id, sandboxUrl],
    enabled: open && !!sandboxUrl && adminHealth?.layers.runtime.status !== 'offline',
    queryFn: async () => {
      const data = await requestSandboxJson<unknown>(sandboxUrl!, '/config/status');
      if (!isSandboxConfigStatus(data)) {
        throw new Error('This runtime does not expose config diagnostics yet.');
      }
      return data;
    },
    staleTime: 5_000,
    retry: false,
    refetchInterval: adminHealth?.layers.runtime.status === 'healthy' ? 10_000 : false,
    refetchOnWindowFocus: true,
  });

  const sandboxProjectsQuery = useQuery<SandboxProjectSummary[]>({
    queryKey: ['sandbox', 'config-status-projects', sandbox?.sandbox_id, sandboxUrl],
    enabled: open && !!sandboxUrl && !!configStatusQuery.data && !configStatusQuery.data.valid,
    queryFn: async () => {
      const data = await requestSandboxJson<unknown>(sandboxUrl!, '/kortix/projects');
      return Array.isArray(data) ? data as SandboxProjectSummary[] : [];
    },
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const configFixPrompt = useMemo(() => {
    if (!sandbox || !configStatusQuery.data || configStatusQuery.data.valid) return null;
    return buildConfigFixPrompt(sandbox, configStatusQuery.data);
  }, [sandbox, configStatusQuery.data]);

  const configFixProject = useMemo(
    () => pickConfigFixProject(sandboxProjectsQuery.data ?? []),
    [sandboxProjectsQuery.data],
  );

  const configFixTaskMutation = useMutation({
    mutationFn: async () => {
      if (!sandbox || !sandboxUrl) throw new Error('Sandbox URL unavailable');
      if (!configStatusQuery.data || configStatusQuery.data.valid) {
        throw new Error('No invalid config source is currently being skipped.');
      }
      const targetProject = configFixProject ?? await requestSandboxJson<SandboxProjectSummary>(sandboxUrl, '/kortix/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Workspace',
          path: '/workspace',
          description: 'Default workspace project for runtime repair tasks.',
        }),
      });

      const task = await requestSandboxJson<{ id: string }>(sandboxUrl, '/kortix/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: targetProject.id,
          title: getConfigFixTaskTitle(configStatusQuery.data),
          description: buildConfigFixPrompt(sandbox, configStatusQuery.data),
          verification_condition: 'GET /config/status returns {"valid":true,"skippedSources":[]} for this instance.',
          status: 'todo',
        }),
      });

      await requestSandboxJson(sandboxUrl, `/kortix/tasks/${encodeURIComponent(task.id)}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      return {
        taskId: task.id,
        project: targetProject,
      };
    },
    onSuccess: ({ taskId, project }) => {
      sonnerToast.success('Fix task started', {
        description: `Task ${taskId} is running in ${project.name || project.path}.`,
      });
    },
    onError: (error) => {
      sonnerToast.error(error instanceof Error ? error.message : 'Failed to start fix task');
    },
  });

  useEffect(() => {
    if (!open) {
      setActiveTab(defaultTab);
      setSetupResult(null);
      setBackupDescription('');
      setRestoreTarget(null);
      setDeleteTarget(null);
      setUpdateDialogOpen(false);
    }
  }, [defaultTab, open]);

  useEffect(() => {
    if (!open) return;
    setActiveTab(defaultTab);
  }, [defaultTab, open, sandbox?.sandbox_id]);

  useEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement) {
      window.requestAnimationFrame(() => active.blur());
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
      sonnerToast.success('Workload restart initiated');
      queryClient.invalidateQueries({ queryKey: ['platform', 'sandbox', 'list'] });
    },
    onError: (error) => {
      sonnerToast.error(error instanceof Error ? error.message : 'Failed to restart workload');
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

  const hostActionPending = restartMutation.isPending || stopMutation.isPending || adminActionMutation.isPending || adminRepairMutation.isPending;
  const showRecoveryCallout = isJustAVPS && (adminHealth?.overall_status === 'offline' || adminHealth?.overall_status === 'degraded' || effectiveStatus === 'stopped' || effectiveStatus === 'error' || !!providerError);

  function actionSuccessMessage(action: AdminInstanceLayerAction['action'], serviceId?: string) {
    switch (action) {
      case 'start_host': return 'Host start initiated';
      case 'reboot_host': return 'Host reboot initiated';
      case 'stop_host': return 'Host stop initiated';
      case 'start_workload': return 'Workload start initiated';
      case 'restart_workload': return 'Workload restart initiated';
      case 'stop_workload': return 'Workload stop initiated';
      case 'restart_runtime': return 'Core runtime restart initiated';
      case 'restart_service': return `${serviceId || 'Service'} restart initiated`;
      default: return 'Action initiated';
    }
  }

  function triggerHostAction(action: 'start' | 'stop' | 'reboot') {
    if (!sandbox) return;
    if (isAdmin) {
      adminActionMutation.mutate(
        { sandboxId: sandbox.sandbox_id, action },
        {
          onSuccess: () => {
            sonnerToast.success(`${action === 'reboot' ? 'Host restart' : action === 'start' ? 'Host start' : 'Host stop'} initiated`);
            queryClient.invalidateQueries({ queryKey: ['platform', 'sandbox', 'list'] });
            adminDetailQuery.refetch();
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

  function triggerRepairAction(action: AdminInstanceLayerAction['action'], serviceId?: string) {
    if (!sandbox || !isAdmin) return;
    adminRepairMutation.mutate(
      { sandboxId: sandbox.sandbox_id, action, serviceId },
      {
        onSuccess: () => {
          sonnerToast.success(actionSuccessMessage(action, serviceId));
          void adminHealthQuery.refetch();
          void adminDetailQuery.refetch();
        },
        onError: (error) => {
          sonnerToast.error(error instanceof Error ? error.message : `Failed to run ${action}`);
        },
      },
    );
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
  const runtimeServices = Array.isArray(adminHealth?.layers.runtime.details.services)
    ? adminHealth.layers.runtime.details.services as Array<{ id: string; name: string; status: string; scope?: string; lastError?: string | null }>
    : [];
  const runtimeProbeIssues = Array.isArray(adminHealth?.layers.runtime.details.runtime_probe_issues)
    ? adminHealth.layers.runtime.details.runtime_probe_issues as string[]
    : [];
  const configDiagnosticsError = adminHealth?.layers.runtime.status === 'offline'
    ? 'Config diagnostics unavailable while the runtime is offline.'
    : adminHealth?.layers.runtime.status === 'degraded' && runtimeProbeIssues.length > 0
      ? `Config diagnostics unavailable while the runtime is degraded: ${runtimeProbeIssues.join(' · ')}`
      : configStatusQuery.error instanceof Error
        ? configStatusQuery.error.message
        : null;
  const configDiagnosticsLoading = !configDiagnosticsError && configStatusQuery.isPending;

  function layerTone(status: AdminInstanceLayerHealth['status']) {
    switch (status) {
      case 'healthy': return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200';
      case 'degraded': return 'border-amber-500/30 bg-amber-500/10 text-amber-200';
      case 'offline': return 'border-red-500/30 bg-red-500/10 text-red-200';
      default: return 'border-border/60 bg-muted/10 text-muted-foreground';
    }
  }

  function serviceTone(status: string) {
    switch (status) {
      case 'running':
        return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200';
      case 'unresponsive':
      case 'backoff':
        return 'border-amber-500/30 bg-amber-500/10 text-amber-200';
      case 'failed':
      case 'stopped':
        return 'border-red-500/30 bg-red-500/10 text-red-200';
      default:
        return 'border-border/60 bg-muted/10 text-muted-foreground';
    }
  }

  function actionButtonVariant(action: AdminInstanceLayerAction['action']) {
    if (action === 'stop_host' || action === 'stop_workload') return 'ghost' as const;
    return action === 'reboot_host' ? 'default' as const : 'outline' as const;
  }

  async function handleCopyConfigFixPrompt() {
    if (!configFixPrompt) return;
    try {
      await navigator.clipboard.writeText(configFixPrompt);
      sonnerToast.success('Fix prompt copied', {
        description: 'Share it with the agent or paste it into a task to repair the skipped source.',
      });
    } catch (error) {
      sonnerToast.error(error instanceof Error ? error.message : 'Failed to copy fix prompt');
    }
  }

  function handleStartConfigFixTask() {
    configFixTaskMutation.mutate();
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className={cn(
            'p-0 gap-0',
            isMobile
              ? 'fixed inset-0 w-screen h-screen max-w-none max-h-none rounded-none m-0 translate-x-0 translate-y-0 left-0 top-0'
              : 'max-w-5xl h-[min(700px,90vh)] max-h-[90vh] overflow-hidden',
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
                  <Button onClick={() => window.open(`/instances/${sandbox.sandbox_id}`, '_blank', 'noopener,noreferrer')}>
                    Open instance
                  </Button>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="flex h-full min-h-0 flex-row">
              <div className="bg-background flex-shrink-0 w-56 p-4 border-r border-border flex flex-col min-h-0">
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

                {sandbox ? (
                  <div className="mt-auto pt-4">
                    <Button className="w-full" onClick={() => window.open(`/instances/${sandbox.sandbox_id}`, '_blank', 'noopener,noreferrer')}>
                      Open instance
                    </Button>
                  </div>
                ) : null}
              </div>

              <div className="flex-1 min-h-0 w-full max-w-full bg-background flex flex-col">
                <div className="flex-1 overflow-y-auto min-h-0">{renderContent()}</div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

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
              <ConfigDegradationPanel
                status={configStatusQuery.data}
                loading={configDiagnosticsLoading}
                error={configDiagnosticsError}
                onCopyPrompt={handleCopyConfigFixPrompt}
                onStartTask={handleStartConfigFixTask}
                taskPending={configFixTaskMutation.isPending}
              taskTargetLabel={configFixProject ? `${configFixProject.name || configFixProject.path} (${configFixProject.path})` : null}
            />
            {showRecoveryCallout && (
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 space-y-3">
                <div className="flex items-start gap-3">
                  <div className="mt-0.5">
                    {adminHealth?.overall_status === 'offline' ? (
                      <WifiOff className="h-4 w-4 text-amber-400" />
                    ) : (
                      <AlertCircle className="h-4 w-4 text-amber-400" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="text-sm font-medium text-foreground">
                      {adminHealth
                        ? `Instance ${adminHealth.overall_status}`
                        : effectiveStatus === 'stopped'
                          ? 'This host is offline'
                          : 'This machine needs attention'}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {adminHealth
                        ? 'Health is split into host, workload, and runtime layers. Use the Health tab to inspect and repair the failing layer directly.'
                        : 'Refresh the health data to inspect the failing layer directly.'}
                    </div>
                    {providerError ? <div className="text-[11px] text-muted-foreground break-words">{providerError}</div> : null}
                  </div>
                </div>
                {adminHealth ? (
                  <div className="grid gap-2 sm:grid-cols-3">
                    {(['host', 'workload', 'runtime'] as const).map((key) => {
                      const layer = adminHealth.layers[key];
                      return (
                        <div key={key} className={cn('rounded-lg border px-3 py-2', layerTone(layer.status))}>
                          <div className="text-[11px] uppercase tracking-wide opacity-80">{layer.label}</div>
                          <div className="mt-1 text-sm font-medium capitalize">{layer.status}</div>
                          <div className="mt-1 text-[11px] text-muted-foreground">{layer.summary}</div>
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            )}
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
              Use the Health tab to inspect host, workload, and runtime layers separately.
            </p>
          </section>
        </div>
      );
    }

    if (activeTab === 'host') {
      return (
        <div className="p-6 space-y-6">
          <div>
            <h2 className="text-lg font-semibold">Health</h2>
            <p className="text-sm text-muted-foreground">Three explicit layers: host machine, workload container, and core runtime services.</p>
          </div>

          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 flex items-start gap-3">
            <TriangleAlert className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
            <div>
              <div className="text-sm font-medium text-foreground">Choose the smallest repair level first</div>
              <div className="text-xs text-muted-foreground mt-1">
                Runtime restart is cheapest, workload restart is next, and host reboot is last resort.
              </div>
            </div>
          </div>

          <ConfigDegradationPanel
            status={configStatusQuery.data}
            loading={configDiagnosticsLoading}
            error={configDiagnosticsError}
            onCopyPrompt={handleCopyConfigFixPrompt}
            onStartTask={handleStartConfigFixTask}
            taskPending={configFixTaskMutation.isPending}
            taskTargetLabel={configFixProject ? `${configFixProject.name || configFixProject.path} (${configFixProject.path})` : null}
          />

          {isAdmin ? (
            adminHealthQuery.isLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading layered health…
              </div>
            ) : adminHealth ? (
              <div className="space-y-4">
                <div className="rounded-xl border border-border/60 bg-muted/10 p-4 flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium">Overall status</div>
                    <div className="text-xs text-muted-foreground mt-1">
                      {adminHealth.recommended_action
                        ? `Recommended action: ${adminHealth.recommended_action.replace(/_/g, ' ')}`
                        : 'All layers healthy'}
                    </div>
                  </div>
                  <div className={cn('rounded-full border px-3 py-1 text-xs font-medium capitalize', layerTone(adminHealth.layers.host.status === 'healthy' && adminHealth.layers.workload.status === 'healthy' && adminHealth.layers.runtime.status === 'healthy' ? 'healthy' : adminHealth.overall_status === 'offline' ? 'offline' : adminHealth.overall_status === 'degraded' ? 'degraded' : 'unknown'))}>
                    {adminHealth.overall_status}
                  </div>
                </div>

                {(['host', 'workload', 'runtime'] as const).map((key) => {
                  const layer = adminHealth.layers[key];
                  const layerServices = key === 'runtime' ? runtimeServices : [];
                  return (
                    <section key={key} className="rounded-xl border border-border/60 bg-muted/10 p-4 space-y-4">
                      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                        <div>
                          <div className="flex items-center gap-2">
                            <div className="text-sm font-medium">{layer.label}</div>
                            <div className={cn('rounded-full border px-2.5 py-0.5 text-[11px] font-medium capitalize', layerTone(layer.status))}>
                              {layer.status}
                            </div>
                          </div>
                          <div className="mt-1 text-xs text-muted-foreground">{layer.summary}</div>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {layer.actions
                            .filter((action) => key !== 'runtime' || action.action !== 'restart_service')
                            .map((action) => (
                              <Button
                                key={`${key}-${action.action}`}
                                size="sm"
                                variant={actionButtonVariant(action.action)}
                                onClick={() => triggerRepairAction(action.action, action.serviceId)}
                                disabled={adminRepairMutation.isPending}
                              >
                                {adminRepairMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-2" /> : null}
                                {action.label}
                              </Button>
                            ))}
                        </div>
                      </div>

                      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 text-xs">
                        {Object.entries(layer.details).filter(([detailKey]) => detailKey !== 'services').map(([detailKey, value]) => (
                          <div key={detailKey} className="rounded-lg border border-border/60 bg-background/60 px-3 py-2">
                            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{detailKey.replace(/_/g, ' ')}</div>
                            <div className="mt-1 break-words font-mono text-foreground/85">{typeof value === 'object' ? JSON.stringify(value) : String(value ?? '—')}</div>
                          </div>
                        ))}
                      </div>

                      {key === 'runtime' && layerServices.length > 0 ? (
                        <div className="space-y-2">
                          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Managed services</div>
                          <div className="space-y-2">
                            {layerServices.map((service) => (
                              <div key={service.id} className="rounded-lg border border-border/60 bg-background/60 px-3 py-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                                <div className="min-w-0">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <div className="text-sm font-medium">{service.name}</div>
                                    <div className={cn('rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide', serviceTone(service.status))}>
                                      {service.status}
                                    </div>
                                  </div>
                                  <div className="mt-1 text-xs text-muted-foreground font-mono">{service.id}</div>
                                  {service.lastError ? <div className="mt-1 text-[11px] text-muted-foreground break-words">{service.lastError}</div> : null}
                                </div>
                                <Button size="sm" variant="outline" onClick={() => triggerRepairAction('restart_service', service.id)} disabled={adminRepairMutation.isPending}>
                                  {adminRepairMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-2" /> : <RotateCw className="h-3.5 w-3.5 mr-2" />}
                                  Restart service
                                </Button>
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : null}
                    </section>
                  );
                })}
              </div>
            ) : (
              <div className="rounded-xl border border-border/60 bg-muted/10 p-4 text-sm text-muted-foreground">
                Health data unavailable.
              </div>
            )
          ) : (
            <div className="rounded-xl border border-border/60 bg-muted/10 p-4 space-y-3">
              <div className="text-sm font-medium">Recovery</div>
              <div className="text-xs text-muted-foreground">Detailed host/workload/runtime controls are available to admins. You can still restart the workload and manage SSH access here.</div>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={() => restartMutation.mutate()} disabled={hostActionPending}>
                  {hostActionPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <RotateCw className="h-4 w-4 mr-2" />}
                  Restart workload
                </Button>
                <Button variant="outline" onClick={() => triggerHostAction('stop')} disabled={effectiveStatus === 'stopped' || hostActionPending}>
                  {hostActionPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                  Stop host
                </Button>
              </div>
            </div>
          )}

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
                <div className="text-sm font-medium">Provider details</div>
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
        ) : backups.error ? (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100">
            <div className="flex items-start gap-3">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="space-y-3">
                <div>
                  <div className="font-medium">Unable to load backups</div>
                  <div className="text-amber-100/80">{backups.error instanceof Error ? backups.error.message : 'Failed to load backups for this instance.'}</div>
                </div>
                <Button variant="outline" size="sm" onClick={() => void backups.refetch()}>
                  Retry
                </Button>
              </div>
            </div>
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

'use client';

import { use, useState, useCallback } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTabStore } from '@/stores/tab-store';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  ArrowLeft, RefreshCw, Power, RotateCw, PlayCircle, Trash2, ShieldCheck,
  CheckCircle, AlertTriangle, XCircle, Loader2, Cpu, MemoryStick, HardDrive, Copy, Check,
  KeyRound, Link2, Terminal as TerminalIcon, Globe, Code2, Activity,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { useAdminRole } from '@/hooks/admin/use-admin-role';
import {
  useAdminSandboxDetail, useAdminSandboxAction, useDeleteAdminSandbox,
} from '@/hooks/admin/use-admin-sandboxes';

// Terminal iframe is client-only, no SSR.
const SandboxWebTerminal = dynamic(() => import('@/components/admin/sandbox-web-terminal'), { ssr: false });

function StatusBadge({ status }: { status: string | null | undefined }) {
  if (!status) return <Badge variant="secondary">unknown</Badge>;
  switch (status.toLowerCase()) {
    case 'ready':
    case 'active':
    case 'running':
      return <Badge variant="highlight">{status}</Badge>;
    case 'pooled':
      return <Badge className="bg-blue-500/10 text-blue-400 border-blue-500/30">{status}</Badge>;
    case 'provisioning':
      return <Badge className="bg-amber-500/10 text-amber-400 border-amber-500/30">{status}</Badge>;
    case 'stopped':
    case 'paused':
    case 'archived':
      return <Badge variant="secondary">{status}</Badge>;
    case 'error':
    case 'failed':
      return <Badge variant="destructive">{status}</Badge>;
    default:
      return <Badge variant="secondary">{status}</Badge>;
  }
}

function formatDate(dateStr: string | null | undefined) {
  if (!dateStr) return '\u2014';
  return new Date(dateStr).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="opacity-60 hover:opacity-100 transition-opacity"
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      title="Copy"
    >
      {copied ? <CheckCircle className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 px-3 py-2 text-sm">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="font-mono text-right break-all">{value ?? '\u2014'}</span>
    </div>
  );
}

function useCopy(text: string) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [text]);
  return { copied, copy };
}

function CopyOverlay({ copied }: { copied: boolean }) {
  return (
    <div
      className={cn(
        'pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg transition-opacity',
        copied ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
      )}
    >
      <div className={cn(
        'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium backdrop-blur-sm transition-colors',
        copied ? 'bg-emerald-500/20 text-emerald-300' : 'bg-white/10 text-white/90',
      )}>
        {copied ? <><Check className="size-3" /> Copied</> : <><Copy className="size-3" /> Click to copy</>}
      </div>
    </div>
  );
}

function CodeBlock({ text, variant = 'default' }: { text: string; variant?: 'default' | 'green' }) {
  const { copied, copy } = useCopy(text);
  return (
    <div className="relative group cursor-pointer min-w-0 w-full" onClick={copy}>
      <pre className={cn(
        'p-3 rounded-lg text-xs font-mono border overflow-x-auto transition-colors leading-relaxed max-w-full',
        'bg-zinc-950 border-zinc-800 hover:border-zinc-700',
        variant === 'green' ? 'text-green-400' : 'text-zinc-300',
      )}>
        {text}
      </pre>
      <CopyOverlay copied={copied} />
    </div>
  );
}

/** Masks the private key inside an `echo '...'` segment of a setup command. */
function SecretCodeBlock({ text }: { text: string }) {
  const { copied, copy } = useCopy(text);
  const masked = text.replace(/(echo\s+')([^']{6})[^']*('[^']*)/, '$1$2••••••$3');
  return (
    <div className="relative group cursor-pointer min-w-0 w-full" onClick={copy}>
      <div className="rounded-lg border bg-zinc-950 border-zinc-800 hover:border-zinc-700 overflow-hidden transition-colors">
        <p className="px-3 py-2.5 text-[11px] font-mono text-green-400 truncate leading-relaxed">{masked}</p>
        <div className="flex items-center gap-1.5 px-3 py-1.5 border-t border-zinc-800 bg-zinc-900/50">
          <KeyRound className="size-2.5 text-zinc-500 shrink-0" />
          <span className="text-[10px] text-zinc-500">Private key hidden · click to copy full command</span>
        </div>
      </div>
      <CopyOverlay copied={copied} />
    </div>
  );
}

/** Deep-redact sensitive keys from arbitrary JSON-serializable values. */
const SECRET_KEYS = new Set([
  'justavpsProxyToken', 'justavpsProxyTokenId', 'private_key', 'privateKey',
  'token', 'secret', 'password', 'apiKey', 'api_key', 'sshPrivateKey', 'ssh_private_key',
  'machineToken', 'machine_token',
]);
function redactSecrets(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redactSecrets);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEYS.has(k) && typeof v === 'string' && v.length > 0) {
      out[k] = `${v.slice(0, 4)}••••••${v.slice(-4)}`;
    } else {
      out[k] = redactSecrets(v);
    }
  }
  return out;
}

function HealthBar({ label, pct, icon: Icon }: { label: string; pct: number | undefined; icon: any }) {
  // JustAVPS sometimes sends 0–1 fractions; normalize.
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
    </div>
  );
}


export default function AdminSandboxDetailPage({ params }: { params: Promise<{ sandboxId: string }> }) {
  const { sandboxId } = use(params);
  const router = useRouter();
  const { data: adminRole, isLoading: roleLoading } = useAdminRole();
  const { data, isLoading, refetch, isFetching } = useAdminSandboxDetail(sandboxId);
  const actionMutation = useAdminSandboxAction();
  const deleteMutation = useDeleteAdminSandbox();
  const [confirmAction, setConfirmAction] = useState<'reboot' | 'stop' | 'start' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const runAction = useCallback((action: 'reboot' | 'stop' | 'start') => {
    actionMutation.mutate({ sandboxId, action }, {
      onSuccess: () => toast.success(`${action} initiated`),
      onError: (e) => toast.error(`${action} failed`, { description: e.message }),
    });
    setConfirmAction(null);
  }, [actionMutation, sandboxId]);

  const closeTab = useTabStore((s) => s.closeTab);
  const handleDelete = useCallback(async () => {
    try {
      await deleteMutation.mutateAsync(sandboxId);
      toast.success('Sandbox deleted');
      closeTab(`sandbox:${sandboxId}`);
      router.push('/admin/sandboxes');
    } catch (e: any) {
      toast.error('Delete failed', { description: e.message });
    }
    setConfirmDelete(false);
  }, [deleteMutation, sandboxId, router, closeTab]);

  if (roleLoading) {
    return (
      <div className="min-h-screen bg-background p-6 max-w-6xl mx-auto space-y-4">
        <Skeleton className="h-8 w-64" /> <Skeleton className="h-96 w-full" />
      </div>
    );
  }
  if (!adminRole?.isAdmin) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center space-y-3">
          <ShieldCheck className="h-12 w-12 text-muted-foreground/40 mx-auto" />
          <h2 className="text-lg font-medium">Admin access required</h2>
        </div>
      </div>
    );
  }

  const sandbox = data?.sandbox;
  const detail = data?.provider_detail;
  const health = detail?.health;
  const status = detail?.status ?? sandbox?.status ?? null;
  const ready = status === 'ready' || status === 'active';
  const sshCmd = detail?.ssh?.command ?? detail?.connect?.ssh_command ?? null;
  const setupCmd = detail?.ssh?.setup_command ?? detail?.connect?.setup_command ?? detail?.ssh_key?.setup_command ?? null;

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-6xl mx-auto px-6 py-5 space-y-5">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Link href="/admin/sandboxes" className="text-muted-foreground hover:text-foreground transition-colors p-1 -ml-1 rounded-md hover:bg-foreground/[0.04]">
            <ArrowLeft className="h-4 w-4" />
          </Link>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-lg font-semibold tracking-tight truncate">
                {sandbox?.name ?? sandbox?.sandboxId?.slice(0, 12) ?? sandboxId.slice(0, 12)}
              </h1>
              <StatusBadge status={status} />
              {sandbox?.provider && (
                <Badge variant="secondary" className="capitalize text-[10px] h-5">{sandbox.provider}</Badge>
              )}
            </div>
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground font-mono mt-0.5">
              <span className="truncate">{sandboxId}</span>
              <CopyButton value={sandboxId} />
              {detail?.ip && <><span className="text-muted-foreground/30">·</span><span>{detail.ip}</span></>}
              {detail?.region && <><span className="text-muted-foreground/30">·</span><span>{detail.region}</span></>}
              {detail?.server_type && <><span className="text-muted-foreground/30">·</span><span>{detail.server_type}</span></>}
            </div>
          </div>

          {/* Action cluster */}
          <div className="flex items-center gap-1 shrink-0">
            <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => refetch()} disabled={isFetching} title="Refresh">
              <RefreshCw className={cn('h-3.5 w-3.5', isFetching ? 'animate-spin' : '')} />
            </Button>
            <div className="h-5 w-px bg-foreground/10 mx-1" />
            <Button size="sm" variant="ghost" className="h-8 gap-1.5" disabled={!ready || actionMutation.isPending} onClick={() => setConfirmAction('reboot')} title="Reboot">
              <RotateCw className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Reboot</span>
            </Button>
            <Button size="sm" variant="ghost" className="h-8 gap-1.5" disabled={!ready || actionMutation.isPending} onClick={() => setConfirmAction('stop')} title="Stop">
              <Power className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Stop</span>
            </Button>
            <Button size="sm" variant="ghost" className="h-8 gap-1.5" disabled={status !== 'stopped' || actionMutation.isPending} onClick={() => setConfirmAction('start')} title="Start">
              <PlayCircle className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Start</span>
            </Button>
          </div>
        </div>

        {data?.provider_error && (
          <div className="flex items-start gap-2 bg-amber-500/5 border border-amber-500/20 rounded-lg px-3 py-2 text-xs">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" />
            <div className="text-muted-foreground">JustAVPS unreachable: {data.provider_error}</div>
          </div>
        )}

        {/* Tabs */}
        <Tabs defaultValue="connect" className="space-y-4">
          <TabsList className="h-9 p-1">
            <TabsTrigger value="connect" className="gap-1.5 text-xs h-7"><Link2 className="size-3.5" /> Connect</TabsTrigger>
            <TabsTrigger value="terminal" className="gap-1.5 text-xs h-7"><TerminalIcon className="size-3.5" /> Terminal</TabsTrigger>
            <TabsTrigger value="overview" className="gap-1.5 text-xs h-7"><Activity className="size-3.5" /> Overview</TabsTrigger>
            <TabsTrigger value="raw" className="gap-1.5 text-xs h-7"><Code2 className="size-3.5" /> Raw</TabsTrigger>
          </TabsList>

          <TabsContent value="terminal" className="space-y-2">
            <SandboxWebTerminal
              sandboxId={sandboxId}
              externalId={sandbox?.externalId ?? null}
              status={status}
              ip={detail?.ip}
              terminalUrl={detail?.urls?.terminal ?? null}
              label={detail?.slug ?? sandboxId.slice(0, 8)}
            />
          </TabsContent>

          <TabsContent value="overview" className="mt-0 space-y-3">
            {/* Health */}
            <div className="rounded-xl border bg-card overflow-hidden">
              <div className="px-4 py-2.5 border-b bg-muted/30 flex items-center justify-between">
                <span className="text-sm font-medium">Resource usage</span>
                {health?.last_heartbeat_at && (
                  <span className="text-[10px] text-muted-foreground">Heartbeat {formatDate(health.last_heartbeat_at)}</span>
                )}
              </div>
              <div className="p-4">
                {isLoading ? (
                  <Skeleton className="h-16 w-full" />
                ) : health ? (
                  <>
                    <div className="grid grid-cols-3 gap-6">
                      <HealthBar label="CPU" pct={health.cpu} icon={Cpu} />
                      <HealthBar label="Memory" pct={health.memory} icon={MemoryStick} />
                      <HealthBar label="Disk" pct={health.disk} icon={HardDrive} />
                    </div>
                    {health.services && Object.keys(health.services).length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mt-4 pt-4 border-t border-border/60">
                        {Object.entries(health.services).map(([name, ok]) => (
                          <Badge key={name} variant="secondary" className={cn(
                            'text-[10px] gap-1 h-5 px-1.5',
                            ok
                              ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                              : 'bg-red-500/10 text-red-400 border-red-500/20',
                          )}>
                            {ok ? <CheckCircle className="size-2.5" /> : <XCircle className="size-2.5" />}
                            {name}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground text-center py-4">No heartbeat data yet</p>
                )}
              </div>
            </div>

            {/* Identity */}
            <div className="rounded-xl border bg-card overflow-hidden">
              <div className="px-4 py-2.5 border-b bg-muted/30 text-sm font-medium">Identity</div>
              <div className="divide-y divide-border/60">
                <InfoRow label="Sandbox ID" value={<span className="flex items-center gap-1.5 justify-end">{sandboxId} <CopyButton value={sandboxId} /></span>} />
                <InfoRow label="External (machine) ID" value={sandbox?.externalId ? <span className="flex items-center gap-1.5 justify-end">{sandbox.externalId} <CopyButton value={sandbox.externalId} /></span> : null} />
                <InfoRow label="Slug" value={detail?.slug} />
                <InfoRow label="Name" value={sandbox?.name} />
                <InfoRow label="Provider" value={sandbox?.provider} />
                <InfoRow label="Region" value={detail?.region} />
                <InfoRow label="Server type" value={detail?.server_type} />
                <InfoRow label="Daemon version" value={detail?.daemon_version} />
                <InfoRow label="Created" value={formatDate(sandbox?.createdAt)} />
                <InfoRow label="Last used" value={formatDate(sandbox?.lastUsedAt)} />
              </div>
            </div>
          </TabsContent>

          <TabsContent value="connect" className="mt-0 space-y-3 min-w-0">
            {/* Step 1 — Save SSH key */}
            <div className="rounded-xl border bg-card overflow-hidden">
              <div className="flex items-center gap-2.5 px-4 py-2.5 border-b bg-muted/30">
                <span className="size-5 rounded-full bg-foreground text-background text-[10px] font-bold flex items-center justify-center shrink-0 leading-none">1</span>
                <span className="text-sm font-medium">Save SSH key &amp; connect</span>
                <div className="ml-auto flex items-center gap-1.5 text-[11px] text-amber-500">
                  <KeyRound className="size-3" />
                  <span>Contains private key</span>
                </div>
              </div>
              <div className="p-4 space-y-2.5 min-w-0">
                <p className="text-xs text-muted-foreground">Run once in your terminal — saves the key and opens an SSH session.</p>
                {setupCmd ? (
                  <SecretCodeBlock text={setupCmd} />
                ) : (
                  <p className="text-xs text-muted-foreground italic">Not available yet — machine still provisioning.</p>
                )}
                {sshCmd && (
                  <>
                    <p className="text-xs text-muted-foreground pt-1">Reconnect later:</p>
                    <CodeBlock text={sshCmd} />
                  </>
                )}
              </div>
            </div>

            {/* Step 2 — Web proxy URLs */}
            {detail?.urls && (detail.urls.proxy || detail.urls.terminal) && (
              <div className="rounded-xl border bg-card overflow-hidden">
                <div className="flex items-center gap-2.5 px-4 py-2.5 border-b bg-muted/30">
                  <span className="size-5 rounded-full bg-foreground text-background text-[10px] font-bold flex items-center justify-center shrink-0 leading-none">2</span>
                  <Globe className="size-3.5 text-muted-foreground" />
                  <span className="text-sm font-medium">Web proxy</span>
                </div>
                <div className="divide-y divide-border/60">
                  {detail.urls.proxy && (
                    <div className="p-4 space-y-1.5 min-w-0">
                      <p className="text-xs text-muted-foreground">Root URL (port 80)</p>
                      <CodeBlock text={detail.urls.proxy} />
                    </div>
                  )}
                  {detail.urls.terminal && (
                    <div className="p-4 space-y-1.5 min-w-0">
                      <p className="text-xs text-muted-foreground">Terminal (iframe URL, requires proxy token)</p>
                      <CodeBlock text={detail.urls.terminal} />
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Owner */}
            <div className="rounded-xl border bg-card overflow-hidden">
              <div className="px-4 py-2.5 border-b bg-muted/30 text-sm font-medium">Owner</div>
              <div className="divide-y divide-border/60">
                <InfoRow label="Account" value={sandbox?.accountName} />
                <InfoRow label="Email" value={sandbox?.ownerEmail} />
                <InfoRow label="Account ID" value={sandbox?.accountId ? <span className="flex items-center gap-1.5 justify-end">{sandbox.accountId} <CopyButton value={sandbox.accountId} /></span> : null} />
                <InfoRow label="Created" value={formatDate(sandbox?.createdAt)} />
                <InfoRow label="Last used" value={formatDate(sandbox?.lastUsedAt)} />
              </div>
            </div>
          </TabsContent>

          <TabsContent value="raw" className="mt-0 space-y-2">
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <ShieldCheck className="size-3" /> Secrets (tokens, private keys) are redacted.
            </div>
            <pre className="text-[11px] bg-zinc-950 text-zinc-300 border border-zinc-800 rounded-lg p-3 overflow-auto max-h-[600px] font-mono leading-relaxed">
              {JSON.stringify(redactSecrets(data), null, 2)}
            </pre>
          </TabsContent>
        </Tabs>
      </div>

      {/* Action confirm */}
      <Dialog open={!!confirmAction} onOpenChange={() => setConfirmAction(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="capitalize">{confirmAction} sandbox</DialogTitle>
            <DialogDescription>
              {confirmAction === 'reboot' && '~30s downtime via provider hard reboot.'}
              {confirmAction === 'stop' && 'Powers off the machine. Billing continues. Use Start to resume.'}
              {confirmAction === 'start' && 'Boots a previously stopped machine.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmAction(null)} disabled={actionMutation.isPending}>Cancel</Button>
            <Button onClick={() => confirmAction && runAction(confirmAction)} disabled={actionMutation.isPending}>
              {actionMutation.isPending ? <><Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> Working…</> : <span className="capitalize">{confirmAction}</span>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <Dialog open={confirmDelete} onOpenChange={() => setConfirmDelete(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete sandbox</DialogTitle>
            <DialogDescription>
              Permanently delete <span className="font-mono">{sandboxId.slice(0, 8)}</span>
              {sandbox?.provider === 'justavps' && ' and terminate the JustAVPS machine'}. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)} disabled={deleteMutation.isPending}>Cancel</Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleteMutation.isPending}>
              {deleteMutation.isPending ? 'Deleting…' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

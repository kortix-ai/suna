'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import {
  X,
  Trash2,
  Power,
  PowerOff,
  Play,
  Loader2,
  Sparkles,
  Timer,
  Webhook,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  SkipForward,
  Clock,
  ExternalLink,
  Copy,
  Check,
} from 'lucide-react';
import {
  useUpdateTrigger,
  useDeleteTrigger,
  useToggleTrigger,
  useRunTrigger,
  useTriggerExecutions,
  type Trigger,
  type Execution,
  type ExecutionStatus,
  type SessionMode,
} from '@/hooks/scheduled-tasks';
import { useSandbox } from '@/hooks/platform/use-sandbox';
import { getSandboxUrl } from '@/lib/platform-client';
import { AgentSelector } from '@/components/session/session-chat-input';
import { useVisibleAgents } from '@/hooks/opencode/use-opencode-sessions';

const TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Asia/Kolkata',
  'Australia/Sydney',
];

const TRIGGER_CLS = cn(
  'data-[state=active]:shadow-none',
  'data-[state=active]:ring-0',
  'data-[state=active]:bg-background data-[state=active]:text-foreground',
  'data-[state=active]:border-border/60',
);

export function TriggerDetailDialog({
  trigger,
  open,
  onClose,
}: {
  trigger: Trigger | null;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent
        className="p-0 overflow-hidden gap-0 sm:max-w-2xl h-[80vh] flex flex-col [&>button:last-child]:hidden"
      >
        <DialogTitle className="sr-only">{trigger?.name ?? 'Trigger'}</DialogTitle>
        <DialogDescription className="sr-only">
          Trigger settings, schedule, and execution history.
        </DialogDescription>
        {trigger && <TriggerEditor trigger={trigger} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function TriggerEditor({ trigger, onClose }: { trigger: Trigger; onClose: () => void }) {
  const router = useRouter();
  const { sandbox } = useSandbox();
  const webhookBaseUrl = useMemo(() => {
    try { if (sandbox) return getSandboxUrl(sandbox); } catch {}
    return 'https://<sandbox-url>';
  }, [sandbox]);

  const [tab, setTab] = useState<'settings' | 'executions'>('settings');
  const [name, setName] = useState(trigger.name);
  const [cronExpr, setCronExpr] = useState(trigger.cronExpr || '');
  const [timezone, setTimezone] = useState(trigger.timezone || 'UTC');
  const [prompt, setPrompt] = useState(trigger.prompt);
  const [sessionMode, setSessionMode] = useState<SessionMode>(trigger.sessionMode as SessionMode);
  const [agentName, setAgentName] = useState<string | null>(trigger.agentName || null);
  const [webhookPath, setWebhookPath] = useState(trigger.webhook?.path || '');
  const [isDirty, setIsDirty] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const updateMutation = useUpdateTrigger();
  const deleteMutation = useDeleteTrigger();
  const toggleMutation = useToggleTrigger();
  const runMutation = useRunTrigger();

  const agents = useVisibleAgents();
  const { data: executions = [] } = useTriggerExecutions(
    tab === 'executions' && trigger.triggerId ? trigger.triggerId : '',
  );

  useEffect(() => {
    setName(trigger.name);
    setCronExpr(trigger.cronExpr || '');
    setTimezone(trigger.timezone || 'UTC');
    setPrompt(trigger.prompt);
    setSessionMode(trigger.sessionMode as SessionMode);
    setAgentName(trigger.agentName || null);
    setWebhookPath(trigger.webhook?.path || '');
    setIsDirty(false);
    setConfirmDelete(false);
  }, [trigger.id]);

  const markDirty = () => setIsDirty(true);

  const handleSave = async () => {
    if (!trigger.triggerId) return;
    try {
      const data: any = { name, session_mode: sessionMode, agent_name: agentName || null };
      if (trigger.type === 'cron') {
        data.cron_expr = cronExpr;
        data.timezone = timezone;
      }
      if (trigger.type === 'webhook') {
        data.source = { path: webhookPath };
      }
      if (trigger.action_type === 'prompt' || !trigger.action_type) {
        data.prompt = prompt;
      }
      await updateMutation.mutateAsync({ id: trigger.triggerId, data });
      toast.success('Trigger updated');
      setIsDirty(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update');
    }
  };

  const handleToggle = async () => {
    if (!trigger.triggerId) return;
    try {
      await toggleMutation.mutateAsync({ id: trigger.triggerId, isActive: !trigger.isActive });
      toast.success(trigger.isActive ? 'Trigger paused' : 'Trigger resumed');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to toggle');
    }
  };

  const handleRun = async () => {
    if (!trigger.triggerId) return;
    try {
      await runMutation.mutateAsync(trigger.triggerId);
      toast.success('Trigger fired');
      setTab('executions');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to run');
    }
  };

  const handleDelete = async () => {
    if (!trigger.triggerId) return;
    try {
      await deleteMutation.mutateAsync(trigger.triggerId);
      toast.success('Trigger deleted');
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete');
    }
  };

  const isPromptAction = trigger.action_type === 'prompt' || !trigger.action_type;
  const isCron = trigger.type === 'cron';
  const TypeIcon = isCron ? Timer : Webhook;
  const anyPending = updateMutation.isPending || deleteMutation.isPending || toggleMutation.isPending || runMutation.isPending;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 px-5 pt-4 shrink-0">
        <Sparkles className="size-3.5 text-muted-foreground/50" />
        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {isCron ? 'Cron trigger' : 'Webhook'}
        </span>
        <span className="text-muted-foreground/30">·</span>
        <span className={cn(
          'inline-flex h-5 items-center rounded-md px-1.5 text-[10px] font-medium uppercase tracking-[0.06em]',
          trigger.isActive
            ? 'bg-emerald-500/10 text-emerald-500/90'
            : 'bg-muted/60 text-muted-foreground/80',
        )}>
          {trigger.isActive ? 'Active' : 'Paused'}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onClose}
          className="ml-auto text-muted-foreground hover:text-foreground"
          aria-label="Close"
        >
          <X />
        </Button>
      </div>

      <div className="flex items-start gap-3 px-5 pt-3 shrink-0">
        <div className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/70">
          <TypeIcon className="size-4" />
        </div>
        <textarea
          value={name}
          onChange={(e) => { setName(e.target.value); markDirty(); }}
          placeholder="Trigger name"
          rows={1}
          maxLength={120}
          className="w-full resize-none overflow-hidden border-0 bg-transparent pt-px text-lg font-semibold leading-tight tracking-tight outline-none placeholder:text-muted-foreground/30 focus:ring-0"
        />
      </div>

      <div className="px-5 pt-4 shrink-0">
        <Tabs value={tab} onValueChange={(v) => setTab(v as 'settings' | 'executions')}>
          <TabsList>
            <TabsTrigger value="settings" className={cn('flex-none px-3', TRIGGER_CLS)}>
              Settings
            </TabsTrigger>
            <TabsTrigger value="executions" className={cn('flex-none px-3', TRIGGER_CLS)}>
              Executions
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
        {tab === 'settings' ? (
          <div className="space-y-5">
            {isCron ? (
              <>
                <Field label="Schedule" hint="6-field cron: second minute hour day month weekday">
                  <Input
                    value={cronExpr}
                    onChange={(e) => { setCronExpr(e.target.value); markDirty(); }}
                    placeholder="0 0 * * * *"
                  />
                </Field>

                <Field label="Timezone">
                  <Select value={timezone} onValueChange={(v) => { setTimezone(v); markDirty(); }}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TIMEZONES.map((tz) => (
                        <SelectItem key={tz} value={tz}>{tz}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              </>
            ) : (
              <>
                <Field label="Path">
                  <Input
                    value={webhookPath}
                    onChange={(e) => { setWebhookPath(e.target.value); markDirty(); }}
                    placeholder="/hooks/my-endpoint"
                  />
                </Field>

                <WebhookUrlBlock
                  url={`${webhookBaseUrl}${trigger.webhook?.path || webhookPath || '/hooks/...'}`}
                  secretProtected={trigger.webhook?.secretProtected}
                />
              </>
            )}

            {isPromptAction && (
              <Field label="Prompt" hint="Sent to the agent each time the trigger fires.">
                <Textarea
                  value={prompt}
                  onChange={(e) => { setPrompt(e.target.value); markDirty(); }}
                  placeholder="The instruction sent to your agent…"
                  rows={5}
                  className="resize-y text-sm leading-relaxed"
                />
              </Field>
            )}

            {isPromptAction && (
              <div className="grid grid-cols-2 gap-4">
                <Field label="Session mode">
                  <Select
                    value={sessionMode}
                    onValueChange={(v) => { setSessionMode(v as SessionMode); markDirty(); }}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="new">New session each fire</SelectItem>
                      <SelectItem value="reuse">Reuse session</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>

                <Field label="Agent">
                  <div className="rounded-lg border border-input bg-transparent px-2 py-1">
                    <AgentSelector
                      agents={agents}
                      selectedAgent={agentName}
                      onSelect={(next) => { setAgentName(next); markDirty(); }}
                    />
                  </div>
                </Field>
              </div>
            )}

            <InfoGrid trigger={trigger} />
          </div>
        ) : (
          <ExecutionsList
            executions={executions}
            onOpenSession={(sid) => router.push(`/sessions/${sid}`)}
          />
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-border/40 px-5 py-3 shrink-0">
        {confirmDelete ? (
          <>
            <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)} disabled={anyPending}>
              Cancel
            </Button>
            <Button size="sm" variant="destructive" onClick={handleDelete} disabled={anyPending} className="gap-1.5">
              {deleteMutation.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
              Confirm delete
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setConfirmDelete(true)}
            disabled={!trigger.triggerId || anyPending}
            className="gap-1.5 text-muted-foreground/60 hover:text-destructive"
          >
            <Trash2 className="size-3.5" />
            Delete
          </Button>
        )}

        <div className="ml-auto flex items-center gap-2">
          {trigger.triggerId && trigger.type === 'cron' && (
            <Button
              size="sm"
              variant="ghost"
              onClick={handleToggle}
              disabled={anyPending}
              className="gap-1.5 text-muted-foreground hover:text-foreground"
            >
              {trigger.isActive ? <PowerOff className="size-3.5" /> : <Power className="size-3.5" />}
              {trigger.isActive ? 'Pause' : 'Resume'}
            </Button>
          )}
          {trigger.triggerId && (
            <Button size="sm" variant="outline" onClick={handleRun} disabled={anyPending} className="gap-1.5">
              {runMutation.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
              Run now
            </Button>
          )}
          {isDirty && (
            <Button size="sm" onClick={handleSave} disabled={anyPending}>
              {updateMutation.isPending && <Loader2 className="size-3.5 animate-spin" />}
              Save changes
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground/55">{hint}</p>}
    </div>
  );
}

function InfoGrid({ trigger }: { trigger: Trigger }) {
  const rows: Array<[string, string]> = [
    ['Type', `${trigger.type} → ${trigger.action_type ?? 'prompt'}`],
    ['Next run', trigger.type === 'cron'
      ? (trigger.isActive ? formatDateTime(trigger.nextRunAt) : 'Paused')
      : 'On demand',
    ],
    ['Last run', formatDateTime(trigger.lastRunAt)],
  ];
  if (trigger.action_type === 'prompt' || !trigger.action_type) {
    rows.push(['Model', trigger.modelId || 'Default (Sonnet)']);
    rows.push(['Agent', trigger.agentName || 'Default']);
  }
  rows.push(['Created', new Date(trigger.createdAt).toLocaleDateString()]);

  return (
    <div className="overflow-hidden rounded-xl bg-muted/30">
      {rows.map(([k, v], i) => (
        <div
          key={k}
          className={cn(
            'flex items-center justify-between gap-3 px-3 py-2 text-xs',
            i !== rows.length - 1 && 'border-b border-border/40',
          )}
        >
          <span className="text-muted-foreground/70">{k}</span>
          <span className="truncate font-medium tabular-nums text-foreground">{v}</span>
        </div>
      ))}
    </div>
  );
}

function WebhookUrlBlock({ url, secretProtected }: { url: string; secretProtected?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(url).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  return (
    <div className="overflow-hidden rounded-xl bg-muted/30">
      <div className="flex items-center justify-between border-b border-border/40 px-3 py-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/70">
          Endpoint
        </span>
        <div className="flex items-center gap-1.5">
          {secretProtected && (
            <span className="text-[10px] uppercase tracking-[0.06em] text-emerald-500/80">
              secret-protected
            </span>
          )}
          <button
            type="button"
            onClick={copy}
            className="inline-flex size-5 items-center justify-center rounded text-muted-foreground/55 hover:bg-muted hover:text-foreground"
            aria-label="Copy URL"
            title="Copy URL"
          >
            {copied ? <Check className="size-3 text-emerald-500" /> : <Copy className="size-3" />}
          </button>
        </div>
      </div>
      <span className="block break-all px-3 py-2 text-xs leading-relaxed text-foreground/85">
        {url}
      </span>
    </div>
  );
}

function ExecutionsList({
  executions,
  onOpenSession,
}: {
  executions: Execution[];
  onOpenSession: (sessionId: string) => void;
}) {
  if (executions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <Clock className="size-6 text-muted-foreground/40" />
        <p className="mt-3 text-sm font-medium text-foreground">No executions yet</p>
        <p className="mt-1 text-xs text-muted-foreground/65">
          Once this trigger fires, runs will appear here.
        </p>
      </div>
    );
  }
  return (
    <ul className="overflow-hidden rounded-xl bg-muted/30">
      {executions.map((e, i) => (
        <li
          key={e.executionId}
          className={cn(
            'group flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-muted/60',
            i !== executions.length - 1 && 'border-b border-border/40',
            e.sessionId && 'cursor-pointer',
          )}
          onClick={() => { if (e.sessionId) onOpenSession(e.sessionId); }}
        >
          {statusIcon(e.status)}
          <span className={cn('text-sm font-medium capitalize', statusColor(e.status))}>
            {e.status}
          </span>
          {e.retryCount > 0 && (
            <span className="text-xs text-muted-foreground/65">retry {e.retryCount}</span>
          )}
          <span className="ml-auto flex items-center gap-3 text-xs tabular-nums text-muted-foreground/65">
            <span>{formatDuration(e.durationMs)}</span>
            <span>{e.startedAt ? new Date(e.startedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '--'}</span>
            {e.sessionId && <ExternalLink className="size-3 text-muted-foreground/40 transition-colors group-hover:text-foreground" />}
          </span>
        </li>
      ))}
    </ul>
  );
}

function statusIcon(status: ExecutionStatus) {
  switch (status) {
    case 'completed': return <CheckCircle2 className="size-3.5 text-emerald-500" />;
    case 'failed': return <XCircle className="size-3.5 text-red-500" />;
    case 'timeout': return <AlertTriangle className="size-3.5 text-amber-500" />;
    case 'skipped': return <SkipForward className="size-3.5 text-muted-foreground" />;
    case 'running': return <Loader2 className="size-3.5 text-blue-500 animate-spin" />;
    default: return <Clock className="size-3.5 text-muted-foreground" />;
  }
}

function statusColor(status: ExecutionStatus): string {
  switch (status) {
    case 'completed': return 'text-emerald-600 dark:text-emerald-400';
    case 'failed': return 'text-red-600 dark:text-red-400';
    case 'timeout': return 'text-amber-600 dark:text-amber-400';
    case 'skipped': return 'text-muted-foreground';
    case 'running': return 'text-blue-600 dark:text-blue-400';
    default: return 'text-muted-foreground';
  }
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '--';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function formatDateTime(s: string | null): string {
  if (!s) return 'Never';
  return new Date(s).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

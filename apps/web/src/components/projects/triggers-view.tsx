'use client';

/**
 * <TriggersView /> — Shared body for the Customize "Schedules" and
 * "Webhooks" pages. One component, type-scoped: pass `type: "cron"` for
 * schedules, `type: "webhook"` for webhooks. The list is filtered, the
 * Create dialog is forced to the matching type (no source picker), and
 * the page copy / empty state / detail sheet adapt accordingly.
 *
 * UX shape, per type:
 *   • Schedules — rows show cron description + timezone; create dialog
 *     opens straight into the cron-preset builder.
 *   • Webhooks  — rows show signing-secret status; create dialog opens
 *     straight into the signing-secret field; detail sheet exposes
 *     endpoint URL + curl example.
 *
 * The CRUD path is the same in both cases — kortix.toml round-trip via
 * `createProjectTrigger` / `updateProjectTrigger` / `deleteProjectTrigger`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Calendar,
  CheckCircle2,
  Clock,
  Copy,
  Loader2,
  MessageSquare,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Terminal,
  Timer,
  Trash2,
  Webhook,
  Zap,
} from 'lucide-react';

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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { ScheduleBuilder } from '@/components/scheduled-tasks/schedule-builder';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { getEnv } from '@/lib/env-config';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import {
  createProjectTrigger,
  deleteProjectTrigger,
  fireProjectTrigger,
  listProjectTriggers,
  updateProjectTrigger,
  upsertProjectSecret,
  type ProjectTrigger,
} from '@/lib/projects-client';

/* ─── Cron presets ──────────────────────────────────────────────────────── */

interface CronPreset {
  id: string;
  label: string;
  hint: string;
  /** 6-field croner expression (sec min hour day month weekday). */
  expr: string;
}

const CRON_PRESETS: readonly CronPreset[] = [
  { id: '5m',    label: 'Every 5 minutes',   hint: 'Frequent polling',         expr: '0 */5 * * * *' },
  { id: '15m',   label: 'Every 15 minutes',  hint: 'Modest polling',           expr: '0 */15 * * * *' },
  { id: '1h',    label: 'Hourly',            hint: 'At the top of each hour',  expr: '0 0 * * * *' },
  { id: 'daily', label: 'Daily at 09:00',    hint: 'Once a day',               expr: '0 0 9 * * *' },
  { id: 'wkdy',  label: 'Weekdays at 09:00', hint: 'Mon–Fri morning',          expr: '0 0 9 * * 1-5' },
  { id: 'wkly',  label: 'Mondays at 09:00',  hint: 'Once a week',              expr: '0 0 9 * * 1' },
];

function describeCron(expr: string): string {
  const trimmed = expr.trim();
  const preset = CRON_PRESETS.find((p) => p.expr === trimmed);
  if (preset) return preset.label;

  // Fall back to a tiny pattern-match for the most common ad-hoc shapes so a
  // user-typed expression doesn't always read as raw cron syntax.
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 6) return trimmed;
  const [, min, hour, day, month, weekday] = parts;
  if (min.startsWith('*/') && hour === '*') {
    const n = min.slice(2);
    return `Every ${n} minute${n === '1' ? '' : 's'}`;
  }
  if (min === '0' && hour.startsWith('*/')) {
    const n = hour.slice(2);
    return `Every ${n} hour${n === '1' ? '' : 's'}`;
  }
  if (min !== '*' && hour !== '*' && day === '*' && month === '*') {
    const t = `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
    if (weekday === '*') return `Daily at ${t}`;
    if (weekday === '1-5') return `Weekdays at ${t}`;
    if (weekday === '0,6' || weekday === '6,0') return `Weekends at ${t}`;
    return `At ${t} on day ${weekday}`;
  }
  return trimmed;
}

/* ─── Helpers ───────────────────────────────────────────────────────────── */

function getTriggerName(t: ProjectTrigger): string {
  if (t.name?.trim()) return t.name.trim();
  if (t.type === 'cron' && t.cron) return describeCron(t.cron);
  return t.type === 'webhook' ? 'Webhook trigger' : 'Cron trigger';
}

function getTriggerSubtitle(t: ProjectTrigger): string {
  if (t.type === 'cron') return t.timezone;
  return t.secret_env ? `Signed via ${t.secret_env}` : 'Unsigned';
}

function relativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

function buildWebhookUrl(triggerId: string): string {
  let backendUrl = '';
  try {
    backendUrl = getEnv().BACKEND_URL ?? '';
  } catch {
    /* no-op — fall back to placeholder below */
  }
  if (!backendUrl) return `[BACKEND_URL]/webhooks/${triggerId}`;
  return `${backendUrl.replace(/\/$/, '')}/webhooks/${triggerId}`;
}

function buildCurlExample(url: string): string {
  // We deliberately keep the body small and the openssl invocation legible so
  // a user can copy-paste this once and have a working sample.
  return [
    `curl -X POST ${url} \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -H "X-Kortix-Signature: sha256=$(echo -n '$BODY' | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')" \\`,
    `  -d '$BODY'`,
    ``,
    `# Where:`,
    `#   BODY    = '{"event":"deploy.succeeded","ref":"main"}'`,
    `#   SECRET  = the signing secret you set when creating this trigger`,
  ].join('\n');
}

/** Cryptographically random base64url string (~32 bytes of entropy). */
function generateSecret(): string {
  if (typeof crypto !== 'undefined' && 'getRandomValues' in crypto) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

async function copyToClipboard(value: string, label = 'Copied'): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(label);
    return true;
  } catch {
    toast.error('Copy failed — select and copy manually');
    return false;
  }
}

/* ─── View entry ────────────────────────────────────────────────────────── */

type TriggerKind = 'cron' | 'webhook';

interface TypeMeta {
  /** Top-bar + h1 title for this kind of trigger. */
  pageTitle: string;
  /** Icon for the top bar. */
  icon: typeof Zap;
  /** One-line description under the h1. */
  description: React.ReactNode;
  /** New-button label, e.g. "New schedule". */
  createButtonLabel: string;
  /** Empty-state copy. */
  empty: {
    title: string;
    body: string;
  };
}

const TYPE_META: Record<TriggerKind, TypeMeta> = {
  cron: {
    pageTitle: 'Schedules',
    icon: Timer,
    description: (
      <>
        Cron-driven entry points. When a schedule fires, a fresh session
        sandbox boots with the rendered prompt template injected as{' '}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">
          KORTIX_INITIAL_PROMPT
        </code>
        .
      </>
    ),
    createButtonLabel: 'New schedule',
    empty: {
      title: 'No schedules yet',
      body: 'Schedules spawn a session on a cron expression — daily digests, weekly reports, hourly polls. The agent runs end-to-end on the cloud API.',
    },
  },
  webhook: {
    pageTitle: 'Webhooks',
    icon: Webhook,
    description: (
      <>
        Signed HTTP entry points. When a request hits the webhook URL, a
        fresh session sandbox boots with the rendered prompt template
        injected as{' '}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">
          KORTIX_INITIAL_PROMPT
        </code>
        .
      </>
    ),
    createButtonLabel: 'New webhook',
    empty: {
      title: 'No webhooks yet',
      body: 'Webhooks accept signed HTTP POSTs from external systems — Slack events, deploy hooks, alerting pipelines. Each one routes to a single project session.',
    },
  },
};

export function TriggersView({
  projectId,
  type,
}: {
  projectId: string;
  type: TriggerKind;
}) {
  const meta = TYPE_META[type];
  const Icon = meta.icon;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border/60 px-4">
        <Icon className="h-4 w-4 text-muted-foreground" />
        <h1 className="text-sm font-semibold text-foreground">{meta.pageTitle}</h1>
      </div>
      <ProjectTriggersBody projectId={projectId} type={type} meta={meta} />
    </div>
  );
}

function ProjectTriggersBody({
  projectId,
  type,
  meta,
}: {
  projectId: string;
  type: TriggerKind;
  meta: TypeMeta;
}) {
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => ['project-triggers', projectId], [projectId]);

  const triggersQuery = useQuery({
    queryKey,
    queryFn: () => listProjectTriggers(projectId),
    refetchInterval: 10_000,
    staleTime: 5_000,
  });

  const [createOpen, setCreateOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProjectTrigger | null>(null);

  const isForbidden =
    triggersQuery.isError &&
    /403|forbidden/i.test((triggersQuery.error as Error)?.message ?? '');

  const invalidate = useCallback(
    () => queryClient.invalidateQueries({ queryKey }),
    [queryClient, queryKey],
  );

  // Filter to just this view's type — the API returns every trigger
  // because they share one `kortix.toml`, but each page is scoped.
  const allTriggers = triggersQuery.data?.triggers ?? [];
  const triggers = allTriggers.filter((t) => t.type === type);
  const parseErrors = triggersQuery.data?.errors ?? [];
  const selectedTrigger = triggers.find((t) => t.slug === selectedId) ?? null;
  const activeCount = triggers.filter((t) => t.enabled).length;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl space-y-6 px-4 py-8">
        <header className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2.5">
              <h2 className="text-base font-semibold text-foreground">
                {meta.pageTitle}
              </h2>
              {triggers.length > 0 && (
                <Badge variant="outline" className="h-5 rounded-md px-1.5 text-[10px] font-medium tabular-nums">
                  {activeCount} / {triggers.length} active
                </Badge>
              )}
            </div>
            <p className="max-w-2xl text-xs text-muted-foreground">
              {meta.description}
            </p>
          </div>
          <Button size="sm" className="gap-1.5" onClick={() => setCreateOpen(true)}>
            <Plus className="h-3.5 w-3.5" />
            {meta.createButtonLabel}
          </Button>
        </header>

        {triggersQuery.isLoading ? (
          <TriggersSkeleton />
        ) : isForbidden ? (
          <ForbiddenNotice />
        ) : triggersQuery.isError ? (
          <ErrorNotice
            message={(triggersQuery.error as Error)?.message ?? 'Failed to load triggers'}
            onRetry={() => triggersQuery.refetch()}
          />
        ) : triggers.length === 0 ? (
          <EmptyState
            meta={meta}
            type={type}
            onCreate={() => setCreateOpen(true)}
          />
        ) : (
          <div className="space-y-1.5">
            {triggers.map((trigger) => (
              <TriggerRow
                key={trigger.slug}
                trigger={trigger}
                onSelect={() => setSelectedId(trigger.slug)}
              />
            ))}
          </div>
        )}

        {parseErrors.length > 0 && (
          <section className="space-y-2 rounded-xl border border-amber-500/30 bg-amber-500/[0.04] px-4 py-3">
            <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
              {parseErrors.length} trigger file{parseErrors.length === 1 ? '' : 's'} failed to parse
            </p>
            <ul className="space-y-0.5 text-[11px] text-amber-700/80 dark:text-amber-400/80">
              {parseErrors.map((err) => (
                <li key={err.slug}>
                  <code className="font-mono">{err.path}</code> — {err.error}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      <CreateTriggerDialog
        projectId={projectId}
        forcedType={type}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(newSlug) => {
          setCreateOpen(false);
          invalidate();
          // Drop the user straight into the new trigger's detail so they can
          // grab the webhook URL or test-fire without an extra click.
          setSelectedId(newSlug);
        }}
      />

      <TriggerDetailSheet
        projectId={projectId}
        trigger={selectedTrigger}
        open={!!selectedTrigger}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
        onDelete={() => selectedTrigger && setDeleteTarget(selectedTrigger)}
        onMutated={invalidate}
      />

      <DeleteDialog
        projectId={projectId}
        target={deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onDeleted={() => {
          setDeleteTarget(null);
          setSelectedId(null);
          invalidate();
        }}
      />
    </div>
  );
}

/* ─── Row ───────────────────────────────────────────────────────────────── */

function TriggerRow({
  trigger,
  onSelect,
}: {
  trigger: ProjectTrigger;
  onSelect: () => void;
}) {
  const isCron = trigger.type === 'cron';
  const name = getTriggerName(trigger);
  const subtitle = getTriggerSubtitle(trigger);
  const lastFired = trigger.last_fired_at;

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'group flex w-full items-center gap-3.5 rounded-xl border border-border/70 bg-card px-3.5 py-3 text-left',
        'transition-all duration-150 hover:border-foreground/30 hover:bg-card/80',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/40',
      )}
    >
      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/30 text-muted-foreground">
        {isCron ? <Timer className="h-4 w-4" /> : <Webhook className="h-4 w-4" />}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">{name}</span>
          <StatusDot enabled={trigger.enabled} />
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 truncate text-[11px] text-muted-foreground">
          <span className="font-mono">{trigger.slug.slice(0, 8)}</span>
          <span className="text-muted-foreground/40">·</span>
          <span className="truncate">{subtitle}</span>
        </div>
      </div>

      <div className="hidden flex-col items-end gap-0.5 sm:flex">
        <span className="text-[11px] text-muted-foreground/70 tabular-nums">
          {lastFired ? `Fired ${relativeTime(lastFired)}` : 'Never fired'}
        </span>
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground/40">
          {trigger.agent}
        </span>
      </div>
    </button>
  );
}

function StatusDot({ enabled }: { enabled: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            'relative flex h-1.5 w-1.5 shrink-0 items-center justify-center rounded-full',
            enabled ? 'bg-emerald-500' : 'bg-muted-foreground/40',
          )}
        >
          {enabled && (
            <span className="absolute inset-0 animate-ping rounded-full bg-emerald-500/50" />
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-[10px]">
        {enabled ? 'Active' : 'Paused'}
      </TooltipContent>
    </Tooltip>
  );
}

/* ─── Detail Sheet ──────────────────────────────────────────────────────── */

function TriggerDetailSheet({
  projectId,
  trigger,
  open,
  onOpenChange,
  onDelete,
  onMutated,
}: {
  projectId: string;
  trigger: ProjectTrigger | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDelete: () => void;
  onMutated: () => void;
}) {
  if (!trigger) return null;
  const isCron = trigger.type === 'cron';

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 sm:max-w-[520px] sm:px-0"
      >
        <SheetHeader className="space-y-1 px-5 pt-5 pb-3">
          <div className="flex items-center gap-2.5">
            <div
              className={cn(
                'flex size-7 items-center justify-center rounded-md border',
                isCron
                  ? 'border-amber-500/20 bg-amber-500/5 text-amber-600 dark:text-amber-400'
                  : 'border-blue-500/20 bg-blue-500/5 text-blue-600 dark:text-blue-400',
              )}
            >
              {isCron ? <Timer className="h-3.5 w-3.5" /> : <Webhook className="h-3.5 w-3.5" />}
            </div>
            <SheetTitle className="flex-1 truncate text-sm font-semibold">
              {getTriggerName(trigger)}
            </SheetTitle>
            <Badge
              variant="outline"
              className={cn(
                'h-5 rounded-md px-1.5 text-[10px] font-medium',
                trigger.enabled
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                  : 'text-muted-foreground',
              )}
            >
              {trigger.enabled ? 'Active' : 'Paused'}
            </Badge>
          </div>
          <SheetDescription className="font-mono text-[11px] text-muted-foreground/70">
            {trigger.slug}
          </SheetDescription>
        </SheetHeader>

        <Separator />

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <DetailBody
            projectId={projectId}
            trigger={trigger}
            onMutated={onMutated}
            onDelete={onDelete}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}

function DetailBody({
  projectId,
  trigger,
  onMutated,
  onDelete,
}: {
  projectId: string;
  trigger: ProjectTrigger;
  onMutated: () => void;
  onDelete: () => void;
}) {
  const isCron = trigger.type === 'cron';

  // ── Mutations ──────────────────────────────────────────────────────────
  const fire = useMutation({
    mutationFn: () => fireProjectTrigger(projectId, trigger.slug),
    onSuccess: (res) => {
      if (res.status === 'fired') {
        toast.success('Trigger fired', {
          description: res.session_id
            ? `Session ${res.session_id.slice(0, 8)}…`
            : 'Session provisioning',
        });
      } else if (res.status === 'queued') {
        toast.success('Trigger queued', { description: res.reason ?? 'Backpressure — will retry' });
      } else {
        toast.error('Trigger failed', { description: res.error });
      }
      onMutated();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to fire'),
  });

  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      updateProjectTrigger(projectId, trigger.slug, { enabled }),
    onSuccess: (_data, enabled) => {
      toast.success(enabled ? 'Trigger enabled' : 'Trigger paused');
      onMutated();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to update'),
  });

  return (
    <div className="space-y-6">
      {/* Action bar */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          className="gap-1.5"
          onClick={() => fire.mutate()}
          disabled={fire.isPending}
        >
          {fire.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Play className="h-3.5 w-3.5" />
          )}
          Fire now
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => toggle.mutate(!trigger.enabled)}
          disabled={toggle.isPending}
        >
          {toggle.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : trigger.enabled ? (
            <Pause className="h-3.5 w-3.5" />
          ) : (
            <Play className="h-3.5 w-3.5" />
          )}
          {trigger.enabled ? 'Pause' : 'Enable'}
        </Button>
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={onDelete}
        >
          <Trash2 className="h-3.5 w-3.5" />
          Delete
        </Button>
      </div>

      {/* Type-specific section */}
      {isCron ? (
        <CronSection trigger={trigger} />
      ) : (
        <WebhookSection trigger={trigger} />
      )}

      {/* Prompt template — inline editable */}
      <PromptTemplateSection
        projectId={projectId}
        trigger={trigger}
        onMutated={onMutated}
      />

      {/* Meta */}
      <MetaSection trigger={trigger} />
    </div>
  );
}

/* ─── Detail sections ───────────────────────────────────────────────────── */

function SectionHeader({
  title,
  icon: Icon,
  action,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="h-3.5 w-3.5 text-muted-foreground/60" />
      <span className="flex-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
        {title}
      </span>
      {action}
    </div>
  );
}

function CronSection({ trigger }: { trigger: ProjectTrigger }) {
  const expr = trigger.cron ?? '';
  const tz = trigger.timezone;

  return (
    <section className="space-y-2">
      <SectionHeader title="Schedule" icon={Timer} />
      <div className="space-y-1.5 rounded-xl border border-border/70 bg-muted/20 px-4 py-3">
        <div className="text-sm font-medium text-foreground">{describeCron(expr)}</div>
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <code className="rounded bg-background px-1.5 py-0.5 font-mono">{expr}</code>
          <span className="text-muted-foreground/40">·</span>
          <span>{tz}</span>
        </div>
      </div>
    </section>
  );
}

function WebhookSection({ trigger }: { trigger: ProjectTrigger }) {
  // The API hands us the public webhook URL directly — no client-side
  // assembly needed.
  const url = trigger.webhook_url ?? '';
  const curl = useMemo(() => buildCurlExample(url), [url]);

  return (
    <section className="space-y-3">
      <div className="space-y-2">
        <SectionHeader title="Endpoint" icon={Webhook} />
        <div className="rounded-xl border border-border/70 bg-muted/20">
          <div className="flex items-center gap-2 px-3 py-2">
            <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground">
              {url}
            </code>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 shrink-0 gap-1 px-2 text-[11px]"
              onClick={() => void copyToClipboard(url, 'Webhook URL copied')}
            >
              <Copy className="h-3 w-3" />
              Copy
            </Button>
          </div>
          <Separator />
          <div className="flex items-center gap-2 px-3 py-1.5 text-[10px] text-muted-foreground">
            {trigger.secret_env ? (
              <>
                <CheckCircle2 className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
                Signed via project secret <code className="ml-1 font-mono">{trigger.secret_env}</code>
              </>
            ) : (
              <>
                <AlertTriangle className="h-3 w-3 text-amber-600 dark:text-amber-400" />
                No signing secret configured
              </>
            )}
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <SectionHeader
          title="Sample request"
          icon={Terminal}
          action={
            <Button
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-1.5 text-[10px]"
              onClick={() => void copyToClipboard(curl, 'cURL copied')}
            >
              <Copy className="h-3 w-3" />
              Copy
            </Button>
          }
        />
        <pre className="max-h-[200px] overflow-auto rounded-xl border border-border/40 bg-muted/20 px-3 py-2.5 font-mono text-[10.5px] leading-snug text-foreground">
          {curl}
        </pre>
        <p className="text-[10px] text-muted-foreground/70">
          Replace <code className="font-mono">$BODY</code> and{' '}
          <code className="font-mono">$SECRET</code>. The signature must cover the
          raw request body byte-for-byte.
        </p>
      </div>
    </section>
  );
}

function PromptTemplateSection({
  projectId,
  trigger,
  onMutated,
}: {
  projectId: string;
  trigger: ProjectTrigger;
  onMutated: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(trigger.prompt_template);

  // Re-sync on trigger change (e.g. switching between selections) without
  // clobbering an in-flight edit.
  useEffect(() => {
    if (!editing) setDraft(trigger.prompt_template);
  }, [trigger.prompt_template, editing]);

  const save = useMutation({
    mutationFn: () =>
      updateProjectTrigger(projectId, trigger.slug, { prompt_template: draft }),
    onSuccess: () => {
      toast.success('Prompt saved');
      setEditing(false);
      onMutated();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to save'),
  });

  return (
    <section className="space-y-2">
      <SectionHeader
        title="Prompt template"
        icon={Sparkles}
        action={
          editing ? (
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-[10px]"
                onClick={() => {
                  setDraft(trigger.prompt_template);
                  setEditing(false);
                }}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                className="h-6 px-2 text-[10px]"
                disabled={save.isPending || !draft.trim() || draft === trigger.prompt_template}
                onClick={() => save.mutate()}
              >
                {save.isPending ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  'Save'
                )}
              </Button>
            </div>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-1.5 text-[10px]"
              onClick={() => setEditing(true)}
            >
              <Pencil className="h-3 w-3" />
              Edit
            </Button>
          )
        }
      />
      {editing ? (
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={6}
          className="resize-y font-mono text-[11.5px] leading-relaxed"
          autoFocus
        />
      ) : (
        <pre className="max-h-[200px] overflow-auto whitespace-pre-wrap rounded-xl border border-border/40 bg-muted/20 px-3 py-2.5 font-mono text-[11.5px] leading-relaxed text-foreground">
          {trigger.prompt_template}
        </pre>
      )}
      <p className="text-[10px] text-muted-foreground/70">
        Placeholders: <code className="font-mono">{'{{ message.text }}'}</code>,{' '}
        <code className="font-mono">{'{{ message.source }}'}</code>,{' '}
        <code className="font-mono">{'{{ trigger.type }}'}</code>,{' '}
        <code className="font-mono">{'{{ fired_at }}'}</code>.
      </p>
    </section>
  );
}

function MetaSection({ trigger }: { trigger: ProjectTrigger }) {
  const rows: Array<[label: string, value: string]> = [
    ['Slug', trigger.slug],
    ['Agent', trigger.agent],
    ['Source file', trigger.path],
    ['Last fired', trigger.last_fired_at ? new Date(trigger.last_fired_at).toLocaleString() : 'Never'],
  ];
  return (
    <section className="space-y-2">
      <SectionHeader title="Metadata" icon={AlertCircle} />
      <dl className="rounded-xl border border-border/40 bg-muted/10">
        {rows.map(([label, value], i) => (
          <div
            key={label}
            className={cn(
              'flex items-center justify-between gap-3 px-3 py-2 text-[11.5px]',
              i > 0 && 'border-t border-border/30',
            )}
          >
            <dt className="text-muted-foreground/70">{label}</dt>
            <dd className="truncate font-mono text-foreground">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/* ─── Create dialog — 3-step wizard, mirrors main-branch UX ─────────────── */

const TIMEZONES = [
  'UTC',
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'Europe/London', 'Europe/Berlin', 'Europe/Paris',
  'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Kolkata',
  'Australia/Sydney',
];

type WizardStep = 'source' | 'action' | 'config';

function CreateTriggerDialog({
  projectId,
  open,
  onOpenChange,
  onCreated,
  forcedType,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (slug: string) => void;
  /** When set, the wizard collapses to two steps and the source-type picker
   * + action step are skipped — the dialog only edits the source-specific
   * settings + name/prompt/agent. Used by the per-type pages. */
  forcedType?: TriggerKind;
}) {
  const [step, setStep] = useState<WizardStep>('source');

  // Source
  const [sourceType, setSourceType] = useState<TriggerKind>(forcedType ?? 'cron');
  const [cronExpr, setCronExpr] = useState('0 0 9 * * *');
  const [timezone, setTimezone] = useState('UTC');
  const [webhookSecret, setWebhookSecret] = useState('');

  // Config
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [agentName, setAgentName] = useState('default');

  const [error, setError] = useState<string | null>(null);

  // Reset on close → next open starts fresh.
  useEffect(() => {
    if (!open) {
      setStep('source');
      setSourceType(forcedType ?? 'cron');
      setCronExpr('0 0 9 * * *');
      setTimezone('UTC');
      setWebhookSecret('');
      setName('');
      setPrompt('');
      setAgentName('default');
      setError(null);
    }
  }, [open, forcedType]);

  const create = useMutation({
    mutationFn: async () => {
      const trimmedPrompt = prompt.trim();
      const trimmedName = name.trim();
      if (!trimmedName) throw new Error('Name is required');
      if (sourceType === 'cron' && !cronExpr.trim()) throw new Error('Cron expression is required');
      if (sourceType === 'webhook' && !webhookSecret.trim()) throw new Error('Webhook secret is required');
      if (!trimmedPrompt) throw new Error('Prompt is required');

      const slug = slugifyName(trimmedName);

      // For webhook triggers, the secret VALUE is stored in project_secrets
      // (encrypted) and the trigger file holds only a reference to its name.
      // This keeps credentials out of git.
      let secretEnv: string | undefined;
      if (sourceType === 'webhook') {
        secretEnv = `WEBHOOK_${slug.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}_SECRET`;
        await upsertProjectSecret(projectId, {
          name: secretEnv,
          value: webhookSecret.trim(),
        });
      }

      return createProjectTrigger(projectId, {
        name: trimmedName,
        type: sourceType,
        prompt_template: trimmedPrompt,
        agent: agentName.trim() || 'default',
        ...(sourceType === 'cron'
          ? { cron: cronExpr.trim(), timezone: timezone.trim() || 'UTC' }
          : { secret_env: secretEnv }),
      });
    },
    onSuccess: (listing) => {
      // The endpoint returns the updated listing. The newly-created trigger
      // is in there — find it by name+type so we can open its detail.
      const created = listing.triggers
        .filter((t) => t.type === sourceType && t.name === name.trim())
        .slice(-1)[0];
      toast.success('Trigger created', {
        description:
          sourceType === 'cron'
            ? `Running on ${describeCron(cronExpr.trim())}`
            : 'Webhook URL ready in the detail panel',
      });
      if (created) onCreated(created.slug);
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Failed to create'),
  });

function slugifyName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 128) || 'trigger';
}

  const isValid = (): boolean => {
    if (!name.trim()) return false;
    if (sourceType === 'cron' && !cronExpr.trim()) return false;
    if (sourceType === 'webhook' && !webhookSecret.trim()) return false;
    if (!prompt.trim()) return false;
    return true;
  };

  // Dialog title + per-step description, type-aware. The typed flow
  // (`forcedType` set) is a 2-step wizard, so descriptions are tighter.
  const dialogTitle = forcedType === 'cron'
    ? 'New schedule'
    : forcedType === 'webhook'
      ? 'New webhook'
      : 'Create trigger';
  const dialogIcon = forcedType === 'cron' ? Timer : forcedType === 'webhook' ? Webhook : Calendar;
  const DialogIcon = dialogIcon;
  const stepDescription = (() => {
    if (step === 'source') {
      if (forcedType === 'cron') return 'Pick when this schedule should fire.';
      if (forcedType === 'webhook') return 'Set the signing secret for this webhook.';
      return 'Choose when this trigger should fire.';
    }
    if (step === 'action') return 'Choose what happens when the trigger fires.';
    return 'Configure the details.';
  })();
  const createButtonLabel = forcedType === 'cron'
    ? 'Create Schedule'
    : forcedType === 'webhook'
      ? 'Create Webhook'
      : 'Create Trigger';

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onOpenChange(false)}>
      <DialogContent className="flex max-h-[90vh] flex-col sm:max-w-[540px]">
        <DialogHeader className="shrink-0 space-y-0.5">
          <DialogTitle className="flex items-center gap-2 text-sm font-semibold">
            <DialogIcon className="h-3.5 w-3.5 text-muted-foreground" />
            {dialogTitle}
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground/60">
            {stepDescription}
          </DialogDescription>
        </DialogHeader>

        <div className="-mx-6 flex-1 overflow-y-auto px-6 py-1">
          {/* ── Step 1: Source ───────────────────────────────────── */}
          {step === 'source' && (
            <div className="space-y-4">
              {!forcedType && (
                <div className="space-y-1.5">
                  <div className="px-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-foreground/40">
                    Trigger source
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <SourceCard
                      icon={Timer}
                      title="Cron"
                      description="Time-based schedule"
                      selected={sourceType === 'cron'}
                      onClick={() => setSourceType('cron')}
                    />
                    <SourceCard
                      icon={Webhook}
                      title="Webhook"
                      description="Fires on HTTP request"
                      selected={sourceType === 'webhook'}
                      onClick={() => setSourceType('webhook')}
                    />
                  </div>
                </div>
              )}

              {sourceType === 'cron' && (
                <div className="space-y-1.5 pt-1">
                  <div className="px-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-foreground/40">
                    Schedule
                  </div>
                  <ScheduleBuilder value={cronExpr} onChange={setCronExpr} />
                </div>
              )}

              {sourceType === 'webhook' && (
                <WebhookSourceConfig
                  secret={webhookSecret}
                  onSecretChange={setWebhookSecret}
                />
              )}
            </div>
          )}

          {/* ── Step 2: Action ───────────────────────────────────── */}
          {step === 'action' && (
            <div className="space-y-1.5">
              <div className="px-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-foreground/40">
                Action type
              </div>
              <div className="grid grid-cols-1 gap-2">
                <SourceCard
                  icon={MessageSquare}
                  title="Prompt"
                  description="Spawn a session and send this instruction to the agent"
                  selected
                  onClick={() => {/* prompt is the only cloud action type */}}
                />
              </div>
              <p className="px-1 pt-2 text-[11px] text-muted-foreground/70">
                Command, HTTP, and ticket-create actions live on the legacy
                in-sandbox triggers system. Cloud triggers always spawn a fresh
                project session with the rendered prompt.
              </p>
            </div>
          )}

          {/* ── Step 3: Config ───────────────────────────────────── */}
          {step === 'config' && (
            <div className="space-y-5">
              <div className="space-y-2">
                <Label htmlFor="trigger-name">Name</Label>
                <Input
                  id="trigger-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Daily standup digest"
                  className="rounded-xl"
                  maxLength={64}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="trigger-prompt">Prompt</Label>
                <Textarea
                  id="trigger-prompt"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="Generate the daily status report and save it to /workspace/reports/"
                  rows={4}
                  className="rounded-xl"
                />
                <p className="text-xs text-muted-foreground">
                  Mustache placeholders supported:{' '}
                  <code className="font-mono">{'{{ message.text }}'}</code>,{' '}
                  <code className="font-mono">{'{{ message.source }}'}</code>,{' '}
                  <code className="font-mono">{'{{ trigger.type }}'}</code>,{' '}
                  <code className="font-mono">{'{{ fired_at }}'}</code>.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="trigger-agent">Agent</Label>
                <Input
                  id="trigger-agent"
                  type="text"
                  value={agentName}
                  onChange={(e) => setAgentName(e.target.value)}
                  placeholder="default"
                  className="rounded-xl font-mono text-[13px]"
                />
              </div>

              {error && (
                <div className="flex items-start gap-2 rounded-xl bg-destructive/5 px-3 py-2 text-xs text-destructive">
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                  <span>{error}</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Footer ─────────────────────────────────────────────── */}
        <div className="mt-2 flex shrink-0 items-center justify-between gap-3 border-t pt-4">
          <div className="flex items-center gap-2">
            {step !== 'source' && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  // Typed flow skips the action step entirely — Back jumps
                  // straight from config → source.
                  if (step === 'config') {
                    setStep(forcedType ? 'source' : 'action');
                  } else {
                    setStep('source');
                  }
                }}
                className="cursor-pointer rounded-xl"
              >
                <ArrowLeft className="mr-1 h-4 w-4" /> Back
              </Button>
            )}
            {step === 'source' && sourceType === 'cron' && (
              <Select value={timezone} onValueChange={setTimezone}>
                <SelectTrigger
                  className="h-8 w-auto cursor-pointer gap-1.5 rounded-full border-border/50 bg-transparent px-3 text-sm text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                  title="Timezone"
                >
                  <Clock className="h-3.5 w-3.5" />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TIMEZONES.map((tz) => (
                    <SelectItem key={tz} value={tz} className="cursor-pointer">
                      {tz}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <div className="flex gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
              className="cursor-pointer"
            >
              Cancel
            </Button>
            {step === 'source' && (
              <Button
                size="sm"
                // Typed flow skips the action step — Source → Config.
                onClick={() => setStep(forcedType ? 'config' : 'action')}
                className="cursor-pointer rounded-xl"
              >
                Next <ArrowRight className="ml-1 h-4 w-4" />
              </Button>
            )}
            {step === 'action' && (
              <Button
                size="sm"
                onClick={() => setStep('config')}
                className="cursor-pointer rounded-xl"
              >
                Next <ArrowRight className="ml-1 h-4 w-4" />
              </Button>
            )}
            {step === 'config' && (
              <Button
                size="sm"
                onClick={() => create.mutate()}
                disabled={!isValid() || create.isPending}
                className="cursor-pointer"
              >
                {create.isPending ? 'Creating…' : createButtonLabel}
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SourceCard({
  icon: Icon,
  title,
  description,
  selected,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group flex h-auto w-full items-start gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors',
        selected
          ? 'border-primary/50 bg-primary/[0.04]'
          : 'border-border/50 bg-muted/20 hover:bg-muted/35',
      )}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-foreground">{title}</div>
        <div className="mt-0.5 text-xs text-muted-foreground/60">{description}</div>
      </div>
    </button>
  );
}

function WebhookSourceConfig({
  secret,
  onSecretChange,
}: {
  secret: string;
  onSecretChange: (next: string) => void;
}) {
  return (
    <div className="space-y-3 pt-2">
      <div className="space-y-2">
        <Label>Signing secret</Label>
        <div className="flex gap-2">
          <Input
            value={secret}
            onChange={(e) => onSecretChange(e.target.value)}
            placeholder="shared-secret"
            type="text"
            className="rounded-xl font-mono text-[13px]"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9 gap-1 px-3 text-xs"
            onClick={() => onSecretChange(generateSecret())}
          >
            <RefreshCw className="h-3 w-3" />
            Generate
          </Button>
        </div>
      </div>

      <div className="space-y-1.5 rounded-xl border bg-muted/50 p-3">
        <div className="text-xs font-medium text-muted-foreground">
          External URL
        </div>
        <code className="block break-all font-mono text-xs text-foreground">
          {buildWebhookUrl('<trigger-id>')}
        </code>
        <p className="text-xs text-muted-foreground">
          We generate the trigger id on create. POST a JSON body to this URL
          with an{' '}
          <code className="font-mono text-xs">X-Kortix-Signature</code> header
          set to{' '}
          <code className="font-mono text-xs">sha256=&lt;hmac&gt;</code>
          {' '}computed over the raw body with the secret above.
        </p>
      </div>
    </div>
  );
}

/* ─── Delete dialog ─────────────────────────────────────────────────────── */

function DeleteDialog({
  projectId,
  target,
  onClose,
  onDeleted,
}: {
  projectId: string;
  target: ProjectTrigger | null;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const remove = useMutation({
    mutationFn: (trigger: ProjectTrigger) =>
      deleteProjectTrigger(projectId, trigger.slug),
    onSuccess: () => {
      toast.success('Trigger deleted');
      onDeleted();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to delete'),
  });

  return (
    <AlertDialog open={!!target} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete trigger?</AlertDialogTitle>
          <AlertDialogDescription>
            {target && (
              <>
                Remove{' '}
                <span className="font-medium text-foreground">
                  {getTriggerName(target)}
                </span>{' '}
                and stop any future runs from it. Past events are kept for audit.
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-white hover:bg-destructive/90"
            onClick={() => target && remove.mutate(target)}
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/* ─── Loading / empty / error ───────────────────────────────────────────── */

function TriggersSkeleton() {
  return (
    <div className="space-y-1.5">
      {Array.from({ length: 3 }).map((_, i) => (
        <Skeleton key={i} className="h-[60px] rounded-xl" />
      ))}
    </div>
  );
}

function EmptyState({
  meta,
  type,
  onCreate,
}: {
  meta: TypeMeta;
  type: TriggerKind;
  onCreate: () => void;
}) {
  const Icon = type === 'cron' ? Timer : Webhook;
  return (
    <div className="rounded-2xl border border-dashed border-border/70 bg-card/30 p-10 text-center">
      <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl border border-border/70 bg-card">
        <Icon className="h-5 w-5 text-muted-foreground" />
      </div>
      <h2 className="mt-4 text-base font-semibold text-foreground">
        {meta.empty.title}
      </h2>
      <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">
        {meta.empty.body}
      </p>
      <Button onClick={onCreate} className="mt-5 gap-1.5">
        <Plus className="h-3.5 w-3.5" />
        {meta.createButtonLabel}
      </Button>
    </div>
  );
}

function ForbiddenNotice() {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-border/70 bg-muted/20 px-4 py-3 text-foreground">
      <ShieldAlert className="mt-0.5 h-4 w-4 flex-shrink-0 text-muted-foreground" />
      <div className="space-y-0.5 text-sm">
        <p className="font-medium">Access required</p>
        <p className="text-xs text-muted-foreground">
          You don&apos;t have permission to view this project&apos;s triggers.
        </p>
      </div>
    </div>
  );
}

function ErrorNotice({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3">
      <p className="text-sm font-medium text-destructive">Failed to load triggers</p>
      <p className="mt-1 text-xs text-destructive/80">{message}</p>
      <Button variant="outline" size="sm" className="mt-3" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

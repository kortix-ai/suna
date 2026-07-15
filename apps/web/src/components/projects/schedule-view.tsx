'use client';

import { ScheduleBuilder } from '@/components/scheduled-tasks/schedule-builder';
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
import { Button, buttonVariants } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { InfoBanner } from '@/components/ui/info-banner';
import { Input } from '@/components/ui/input';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Sheet, SheetBody, SheetContent } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { errorToast, successToast } from '@/components/ui/toast';
import { Icon } from '@/features/icon/icon';
import { EmptyState as EmptyStateBox } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { ModelSelector } from '@/features/session/model-selector';
import { AgentSelector, flattenModels } from '@/features/session/session-chat-input';
import CustomizeSectionWrapper from '@/features/workspace/customize/sections/component/section-wrapper';
import { type ModelKey, modelKeyToWire, wireToModelKey } from '@/hooks/runtime/use-model-store';
import { useRuntimeProviders, useVisibleAgents } from '@/hooks/runtime/use-runtime-sessions';
import { getEnv } from '@/lib/env-config';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import { cn } from '@/lib/utils';
import {
  type ProjectTrigger,
  createProjectTrigger,
  deleteProjectTrigger,
  fireProjectTrigger,
  listProjectSessions,
  listProjectTriggers,
  updateProjectTrigger,
  upsertProjectSecret,
} from '@kortix/sdk/projects-client';
import {
  AlarmClockSolid,
  DangerTriangleSolid,
  PauseSolid,
  Pencil,
  PlaySolid,
  Search,
  TrashSolid,
} from '@mynaui/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
  MoreHorizontal,
  Play,
  RefreshCw,
  Timer,
  Webhook,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';

/* ─── Cron presets ──────────────────────────────────────────────────────── */

interface CronPreset {
  id: string;
  label: string;
  hint: string;
  /** 6-field croner expression (sec min hour day month weekday). */
  expr: string;
}

const CRON_PRESETS: readonly CronPreset[] = [
  { id: '5m', label: 'Every 5 minutes', hint: 'Frequent polling', expr: '0 */5 * * * *' },
  { id: '15m', label: 'Every 15 minutes', hint: 'Modest polling', expr: '0 */15 * * * *' },
  { id: '1h', label: 'Hourly', hint: 'At the top of each hour', expr: '0 0 * * * *' },
  { id: 'daily', label: 'Daily at 09:00', hint: 'Once a day', expr: '0 0 9 * * *' },
  { id: 'wkdy', label: 'Weekdays at 09:00', hint: 'Mon–Fri morning', expr: '0 0 9 * * 1-5' },
  { id: 'wkly', label: 'Mondays at 09:00', hint: 'Once a week', expr: '0 0 9 * * 1' },
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

function describeRunAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Runs once';
  return `Runs once on ${d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })}`;
}

function getTriggerName(t: ProjectTrigger): string {
  if (t.name?.trim()) return t.name.trim();
  if (t.type === 'cron' && t.run_at) return describeRunAt(t.run_at);
  if (t.type === 'cron' && t.cron) return describeCron(t.cron);
  return t.type === 'webhook' ? 'Webhook trigger' : 'Cron trigger';
}

function getTriggerSubtitle(t: ProjectTrigger): string {
  if (t.type === 'cron') return t.run_at ? 'One-off' : t.timezone;
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
    successToast(label);
    return true;
  } catch {
    errorToast('Copy failed — select and copy manually');
    return false;
  }
}

type TriggerKind = 'cron' | 'webhook';

interface TypeMeta {
  pageTitle: string;
  icon: typeof Timer;
  createButtonLabel: string;
  empty: {
    title: string;
    body: string;
  };
}

const TYPE_META: Record<TriggerKind, TypeMeta> = {
  cron: {
    pageTitle: 'Schedules',
    icon: Timer,
    createButtonLabel: 'New schedule',
    empty: {
      title: 'No schedules yet',
      body: 'Create a schedule to run the agent on a recurring cadence.',
    },
  },
  webhook: {
    pageTitle: 'Webhooks',
    icon: Webhook,
    createButtonLabel: 'New webhook',
    empty: {
      title: 'No webhooks yet',
      body: 'Create a webhook to start a session from external HTTP events.',
    },
  },
};

export function ScheduleView({ projectId, type }: { projectId: string; type: TriggerKind }) {
  const meta = TYPE_META[type];

  const tHardcodedUi = useTranslations('hardcodedUi');
  const queryClient = useQueryClient();
  const canWrite =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_TRIGGER_CREATE).allowed === true;
  const queryKey = useMemo(() => ['project-triggers', projectId], [projectId]);

  const triggersQuery = useQuery({
    queryKey,
    queryFn: () => listProjectTriggers(projectId),
    refetchInterval: 10_000,
    staleTime: 5_000,
  });

  const [query, setQuery] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProjectTrigger | null>(null);

  const isForbidden =
    triggersQuery.isError && /403|forbidden/i.test((triggersQuery.error as Error)?.message ?? '');

  const invalidate = useCallback(
    () => queryClient.invalidateQueries({ queryKey }),
    [queryClient, queryKey],
  );

  const triggersPaused = triggersQuery.data?.triggers_paused ?? false;

  const allTriggers = triggersQuery.data?.triggers ?? [];
  const triggers = allTriggers.filter((t) => t.type === type);
  const parseErrors = triggersQuery.data?.errors ?? [];
  const selectedTrigger = triggers.find((t) => t.slug === selectedId) ?? null;
  const activeCount = triggers.filter((t) => t.enabled).length;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return triggers;
    return triggers.filter((t) => {
      const name = getTriggerName(t).toLowerCase();
      return (
        name.includes(q) ||
        t.slug.toLowerCase().includes(q) ||
        t.agent.toLowerCase().includes(q) ||
        getTriggerSubtitle(t).toLowerCase().includes(q)
      );
    });
  }, [triggers, query]);

  const showContent = !triggersQuery.isLoading && !isForbidden && !triggersQuery.isError;

  return (
    <>
      <CustomizeSectionWrapper
        title={meta.pageTitle}
        description={
          type === 'cron'
            ? tHardcodedUi(
                'componentsProjectsTriggersView.line253JsxTextCronDrivenEntryPointsWhenAScheduleFires',
              )
            : tHardcodedUi(
                'componentsProjectsTriggersView.line272JsxTextSignedHttpEntryPointsWhenARequestHits',
              )
        }
        action={
          showContent && canWrite ? (
            <Button
              size="sm"
              variant="secondary"
              className="gap-1.5"
              onClick={() => setCreateOpen(true)}
            >
              <Icon.Plus className="size-4 shrink-0" />
              {meta.createButtonLabel}
            </Button>
          ) : null
        }
      >
        <div className="space-y-4">
          {triggersPaused && showContent && (
            <InfoBanner tone="warning" icon={AlertTriangle}>
              Triggers are paused for this project — scheduled runs and incoming webhooks are
              ignored (manual test-fires still work). Resume in Customize → Settings.
            </InfoBanner>
          )}

          {showContent && triggers.length > 0 ? (
            <InputGroupSearch>
              <InputGroupSearchIcon>
                <Search />
              </InputGroupSearchIcon>
              <InputGroupSearchInput
                placeholder={`Search ${type === 'cron' ? 'schedules' : 'webhooks'}`}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <InputGroupSearchClear onClick={() => setQuery('')} />
            </InputGroupSearch>
          ) : null}

          {triggersQuery.isLoading ? (
            <div className="space-y-1">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-10 rounded-md" />
              ))}
            </div>
          ) : isForbidden ? (
            <InfoBanner
              icon={DangerTriangleSolid}
              title={tHardcodedUi.raw(
                'componentsProjectsTriggersView.line1438JsxTextAccessRequired',
              )}
            >
              {tHardcodedUi.raw(
                'componentsProjectsTriggersView.line1440JsxTextYouDonAposTHavePermissionToView',
              )}
            </InfoBanner>
          ) : triggersQuery.isError ? (
            <ErrorState
              size="sm"
              title={tHardcodedUi.raw(
                'componentsProjectsTriggersView.line1450JsxTextFailedToLoadTriggers',
              )}
              description={(triggersQuery.error as Error)?.message ?? 'Failed to load triggers'}
              action={
                <Button variant="outline" size="sm" onClick={() => triggersQuery.refetch()}>
                  Retry
                </Button>
              }
            />
          ) : triggers.length === 0 ? (
            <EmptyStateBox
              icon={type === 'cron' ? Timer : Webhook}
              size="sm"
              title={meta.empty.title}
              action={
                canWrite ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setCreateOpen(true)}
                    className="gap-1.5"
                  >
                    <Icon.Plus className="size-3.5 shrink-0" />
                    {meta.createButtonLabel}
                  </Button>
                ) : null
              }
            />
          ) : filtered.length === 0 ? (
            <p className="text-muted-foreground px-3 py-6 text-center text-xs">
              No matches for <span className="text-foreground font-mono">{query}</span>.
            </p>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="size-8 p-0" />
                    <TableHead>Name</TableHead>
                    <TableHead>{type === 'cron' ? 'Schedule' : 'Signing'}</TableHead>
                    <TableHead>Agent</TableHead>
                    <TableHead>Last fired</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((trigger) => {
                    const name = getTriggerName(trigger);
                    const subtitle = getTriggerSubtitle(trigger);
                    const lastFired = trigger.last_fired_at;

                    return (
                      <TableRow
                        key={trigger.slug}
                        className="cursor-pointer"
                        onClick={() => setSelectedId(trigger.slug)}
                      >
                        <TableCell className="size-8 pr-0 pl-4">
                          <div
                            className={cn(
                              'inline-flex size-8 shrink-0 items-center justify-center rounded-sm border font-semibold',
                              !trigger.enabled
                                ? 'bg-kortix-green/10 text-kortix-green'
                                : 'bg-kortix-red/10 text-kortix-red',
                            )}
                          >
                            {!trigger.enabled ? (
                              <AlarmClockSolid className="size-5 shrink-0" />
                            ) : (
                              <PauseSolid className="size-6 shrink-0" />
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="max-w-[200px]">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium">{name}</p>
                            <p className="text-muted-foreground font-mono text-xs">
                              {trigger.slug.slice(0, 8)}
                            </p>
                          </div>
                        </TableCell>
                        <TableCell className="text-muted-foreground text-sm whitespace-normal">
                          {subtitle}
                        </TableCell>
                        <TableCell className="text-muted-foreground text-xs tracking-wide uppercase">
                          {trigger.agent}
                        </TableCell>
                        <TableCell className="text-muted-foreground text-xs">
                          {lastFired ? relativeTime(lastFired) : 'Never'}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </>
          )}

          {parseErrors.length > 0 && (
            <InfoBanner tone="warning" icon={AlertTriangle} title="Trigger file parse errors">
              <ul className="space-y-0.5 text-xs">
                {parseErrors.map((err) => (
                  <li key={err.slug}>
                    <code className="font-mono">{err.path}</code> — {err.error}
                  </li>
                ))}
              </ul>
            </InfoBanner>
          )}
        </div>
      </CustomizeSectionWrapper>

      <CreateTriggerModal
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
        canWrite={canWrite}
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
    </>
  );
}

function TriggerDetailSheet({
  projectId,
  trigger,
  canWrite,
  open,
  onOpenChange,
  onDelete,
  onMutated,
}: {
  projectId: string;
  trigger: ProjectTrigger | null;
  canWrite: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDelete: () => void;
  onMutated: () => void;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');

  const fire = useMutation({
    mutationFn: () => fireProjectTrigger(projectId, trigger!.slug),
    onSuccess: (res) => {
      if (res.status === 'fired') {
        successToast('Trigger fired', {
          description: res.session_id
            ? `Session ${res.session_id.slice(0, 8)}…`
            : 'Session provisioning',
        });
      } else if (res.status === 'queued') {
        successToast('Trigger queued', { description: res.reason ?? 'Backpressure, will retry' });
      } else {
        errorToast('Trigger failed', { description: res.error });
      }
      onMutated();
    },
    onError: (err) => errorToast(err instanceof Error ? err.message : 'Failed to fire'),
  });

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => updateProjectTrigger(projectId, trigger!.slug, { enabled }),
    onSuccess: (_data, enabled) => {
      successToast(enabled ? 'Trigger enabled' : 'Trigger paused');
      onMutated();
    },
    onError: (err) => errorToast(err instanceof Error ? err.message : 'Failed to update'),
  });

  if (!trigger) return null;

  const isCron = trigger.type === 'cron';

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 sm:max-w-md">
        <SheetBody className="gap-0 space-y-6 overflow-y-auto p-0">
          <header className="space-y-2">
            <h1 className="text-foreground text-xl font-semibold tracking-tight text-balance">
              {getTriggerName(trigger)}
            </h1>
            {canWrite ? (
              <TriggerDetailToolbar
                enabled={trigger.enabled}
                firePending={fire.isPending}
                togglePending={toggle.isPending}
                fireLabel={tHardcodedUi.raw('componentsProjectsTriggersView.line623JsxTextFireNow')}
                onFire={() => fire.mutate()}
                onToggle={() => toggle.mutate(!trigger.enabled)}
                onDelete={onDelete}
              />
            ) : null}
          </header>

          <div className="space-y-8">
            {isCron ? <CronSection trigger={trigger} /> : <WebhookSection trigger={trigger} />}
            <PromptTemplateSection
              projectId={projectId}
              trigger={trigger}
              canWrite={canWrite}
              onMutated={onMutated}
            />
            <AgentModelSection
              projectId={projectId}
              trigger={trigger}
              canWrite={canWrite}
              onMutated={onMutated}
            />
            <MetaSection trigger={trigger} />
          </div>
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}

function TriggerDetailToolbar({
  enabled,
  firePending,
  togglePending,
  fireLabel,
  onFire,
  onToggle,
  onDelete,
}: {
  enabled: boolean;
  firePending: boolean;
  togglePending: boolean;
  fireLabel: string;
  onFire: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <Button size="sm" className="gap-1.5" onClick={onFire} disabled={firePending}>
        {firePending ? (
          <Loading className="shrink-0 animate-spin" />
        ) : (
          <Play className="shrink-0" />
        )}
        {fireLabel}
      </Button>
      <Button size="sm" variant="outline" onClick={onToggle} disabled={togglePending}>
        {togglePending ? (
          <Loading className="shrink-0 animate-spin" />
        ) : enabled ? (
          <PauseSolid className="shrink-0" />
        ) : (
          <PlaySolid className="shrink-0" />
        )}
        {enabled ? 'Pause' : 'Enable'}
      </Button>
      <div className="min-w-2 flex-1" />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon" variant="ghost" aria-label="More actions">
            <MoreHorizontal className="size-4 shrink-0" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem onClick={onDelete} variant="destructive">
            <TrashSolid className="shrink-0" />
            Delete trigger
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function AgentModelSection({
  projectId,
  trigger,
  canWrite,
  onMutated,
}: {
  projectId: string;
  trigger: ProjectTrigger;
  canWrite: boolean;
  onMutated: () => void;
}) {
  const agents = useVisibleAgents({ projectId });
  const { data: providers } = useRuntimeProviders();
  const models = useMemo(() => flattenModels(providers), [providers]);
  const selectedModel = trigger.model ? wireToModelKey(trigger.model) : null;

  const saveAgent = useMutation({
    mutationFn: (agent: string) => updateProjectTrigger(projectId, trigger.slug, { agent }),
    onSuccess: () => {
      successToast('Agent updated');
      onMutated();
    },
    onError: (e: Error) => errorToast(e.message || 'Failed to update agent'),
  });
  const saveModel = useMutation({
    mutationFn: (model: ModelKey | null) =>
      updateProjectTrigger(projectId, trigger.slug, {
        model: model ? modelKeyToWire(model) : null,
      }),
    onSuccess: () => {
      successToast('Model updated');
      onMutated();
    },
    onError: (e: Error) => errorToast(e.message || 'Failed to update model'),
  });

  const [modeDraft, setModeDraft] = useState<'fresh' | 'reuse' | 'pinned'>(trigger.session_mode);
  const [pinDraft, setPinDraft] = useState<string | null>(trigger.session_id);
  const pinnableSessions = useQuery({
    queryKey: ['project-sessions', projectId, 'trigger-pin'],
    queryFn: () => listProjectSessions(projectId),
    enabled: canWrite && modeDraft === 'pinned',
    staleTime: 30_000,
  });
  const saveSession = useMutation({
    mutationFn: (input: { session_mode: 'fresh' | 'reuse' | 'pinned'; session_id: string | null }) =>
      updateProjectTrigger(projectId, trigger.slug, input),
    onSuccess: () => {
      successToast('Session strategy updated');
      onMutated();
    },
    onError: (e: Error) => errorToast(e.message || 'Failed to update session strategy'),
  });
  const sessionModeLabel: Record<'fresh' | 'reuse' | 'pinned', string> = {
    fresh: 'New session each run',
    reuse: "Reuse this trigger's session",
    pinned: 'Pinned session',
  };

  if (!canWrite) {
    return (
      <section className="space-y-2">
        <Label>Agent &amp; model</Label>
        <PropertyTable
          rows={[
            {
              label: 'Agent',
              value: <span className="text-xs tracking-wide uppercase">{trigger.agent}</span>,
            },
            {
              label: 'Model',
              value: (
                <span className="font-mono text-xs">{trigger.model ?? 'Agent default'}</span>
              ),
            },
            {
              label: 'Session',
              value: (
                <span className="text-xs">
                  {sessionModeLabel[trigger.session_mode]}
                  {trigger.session_mode === 'pinned' && trigger.session_id
                    ? ` · ${trigger.session_id.slice(0, 8)}`
                    : ''}
                </span>
              ),
            },
          ]}
        />
      </section>
    );
  }

  return (
    <section className="space-y-4">
      <div className="space-y-2">
        <Label>Agent</Label>
        <div className="bg-card rounded-2xl border px-2 py-1">
          <AgentSelector
            agents={agents}
            selectedAgent={trigger.agent}
            onSelect={(next) => next && saveAgent.mutate(next)}
            disabled={saveAgent.isPending}
          />
        </div>
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <Label>Model</Label>
          {trigger.model && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              disabled={saveModel.isPending}
              onClick={() => saveModel.mutate(null)}
            >
              Use default
            </Button>
          )}
        </div>
        <div className="bg-card rounded-2xl border px-2 py-1">
          <ModelSelector
            models={models}
            providers={providers}
            selectedModel={selectedModel}
            onSelect={(next) => saveModel.mutate(next)}
          />
        </div>
        <p className="text-muted-foreground/70 text-xs leading-relaxed text-pretty">
          Overrides the agent's default model for this trigger's runs. Leave unset to resolve the
          agent → account → platform default at fire time.
        </p>
      </div>
      <div className="space-y-2">
        <Label>Session strategy</Label>
        <div className="bg-card space-y-2 rounded-2xl border px-3 py-2">
          <Select
            value={modeDraft}
            onValueChange={(v) => {
              const m = v as 'fresh' | 'reuse' | 'pinned';
              setModeDraft(m);
              if (m !== 'pinned') {
                setPinDraft(null);
                saveSession.mutate({ session_mode: m, session_id: null });
              }
            }}
            disabled={saveSession.isPending}
          >
            <SelectTrigger className="h-9 w-full cursor-pointer text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="fresh" className="cursor-pointer">
                New session each run
              </SelectItem>
              <SelectItem value="reuse" className="cursor-pointer">
                Reuse this trigger&apos;s session (loop)
              </SelectItem>
              <SelectItem value="pinned" className="cursor-pointer">
                Pin a specific session…
              </SelectItem>
            </SelectContent>
          </Select>
          {modeDraft === 'pinned' && (
            <Select
              value={pinDraft ?? ''}
              onValueChange={(sid) => {
                setPinDraft(sid);
                saveSession.mutate({ session_mode: 'pinned', session_id: sid });
              }}
              disabled={pinnableSessions.isLoading || saveSession.isPending}
            >
              <SelectTrigger className="h-9 w-full cursor-pointer text-sm">
                <SelectValue
                  placeholder={
                    pinnableSessions.isLoading ? 'Loading sessions…' : 'Choose a session to loop'
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {(pinnableSessions.data ?? []).map((s) => (
                  <SelectItem key={s.session_id} value={s.session_id} className="cursor-pointer">
                    {s.name || s.branch_name || s.session_id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <p className="text-muted-foreground/70 text-xs leading-relaxed text-pretty">
            Fresh mints a new session each run; reuse loops this trigger&apos;s own session; pinned
            loops one specific session you choose.
          </p>
        </div>
      </div>
    </section>
  );
}

function PropertyTable({ rows }: { rows: { label: string; value: ReactNode }[] }) {
  return (
    <Table>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.label} className="hover:bg-transparent">
            <TableCell className="text-muted-foreground w-[34%] py-2 text-sm font-medium">
              {row.label}
            </TableCell>
            <TableCell className="py-2 text-sm">{row.value}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function CronSection({ trigger }: { trigger: ProjectTrigger }) {
  const tI18nHardcoded = useTranslations('hardcodedUi');

  if (trigger.run_at) {
    const d = new Date(trigger.run_at);
    const valid = !Number.isNaN(d.getTime());
    return (
      <section className="space-y-2">
        <Label>Schedule</Label>
        <PropertyTable
          rows={[
            {
              label: 'When',
              value: valid ? describeRunAt(trigger.run_at) : 'Runs once',
            },
            {
              label: 'Type',
              value: tI18nHardcoded.raw(
                'autoComponentsProjectsScheduleViewJsxTextOneOffFiresAacd67796',
              ),
            },
          ]}
        />
      </section>
    );
  }

  const expr = trigger.cron ?? '';
  const tz = trigger.timezone;

  return (
    <section className="space-y-2">
      <Label>Schedule</Label>
      <PropertyTable
        rows={[
          { label: 'When', value: describeCron(expr) },
          {
            label: 'Expression',
            value: <code className="text-foreground text-xs font-medium">{expr}</code>,
          },
          { label: 'Timezone', value: tz },
        ]}
      />
    </section>
  );
}

function WebhookSection({ trigger }: { trigger: ProjectTrigger }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const url = trigger.webhook_url ?? '';
  const curl = useMemo(() => buildCurlExample(url), [url]);

  return (
    <div className="space-y-8">
      <section className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <Label>Endpoint</Label>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-xs"
            onClick={() => void copyToClipboard(url, 'Webhook URL copied')}
          >
            <Copy className="size-3 shrink-0" />
            Copy
          </Button>
        </div>
        <code className="text-foreground block truncate text-xs font-medium">{url}</code>
        {trigger.secret_env ? (
          <InfoBanner tone="success" className="text-xs">
            {tHardcodedUi.raw(
              'componentsProjectsTriggersView.line744JsxTextSignedViaProjectSecret',
            )}{' '}
            <code className="font-medium">{trigger.secret_env}</code>
          </InfoBanner>
        ) : (
          <InfoBanner tone="warning" className="text-xs">
            {tHardcodedUi.raw(
              'componentsProjectsTriggersView.line749JsxTextNoSigningSecretConfigured',
            )}
          </InfoBanner>
        )}
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <Label>Sample request</Label>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-xs"
            onClick={() => void copyToClipboard(curl, 'cURL copied')}
          >
            <Copy className="size-3 shrink-0" />
            Copy
          </Button>
        </div>
        <pre className="bg-muted/40 text-foreground max-h-[200px] overflow-auto rounded-md px-3 py-2.5 font-mono text-xs leading-snug">
          {curl}
        </pre>
        <p className="text-muted-foreground/70 text-xs leading-relaxed text-pretty">
          Replace{' '}
          <code className="font-mono">
            {tHardcodedUi.raw('componentsProjectsTriggersView.line776JsxTextBody')}
          </code>{' '}
          and{' '}
          <code className="font-mono">
            {tHardcodedUi.raw('componentsProjectsTriggersView.line777JsxTextSecret')}
          </code>
          {tHardcodedUi.raw(
            'componentsProjectsTriggersView.line777JsxTextTheSignatureMustCoverTheRawRequestBody',
          )}
        </p>
      </section>
    </div>
  );
}

function PromptTemplateSection({
  projectId,
  trigger,
  canWrite,
  onMutated,
}: {
  projectId: string;
  trigger: ProjectTrigger;
  canWrite: boolean;
  onMutated: () => void;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(trigger.prompt_template);

  useEffect(() => {
    if (!editing) setDraft(trigger.prompt_template);
  }, [trigger.prompt_template, editing]);

  const save = useMutation({
    mutationFn: () => updateProjectTrigger(projectId, trigger.slug, { prompt_template: draft }),
    onSuccess: () => {
      successToast('Prompt saved');
      setEditing(false);
      onMutated();
    },
    onError: (err) => errorToast(err instanceof Error ? err.message : 'Failed to save'),
  });

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Label>
          {tHardcodedUi.raw('componentsProjectsTriggersView.line817JsxAttrTitlePromptTemplate')}
        </Label>
        {!canWrite ? null : editing ? (
          <ButtonGroup>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setDraft(trigger.prompt_template);
                setEditing(false);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={save.isPending || !draft.trim() || draft === trigger.prompt_template}
              onClick={() => save.mutate()}
            >
              {save.isPending ? <Loading className="size-3 shrink-0" /> : 'Save'}
            </Button>
          </ButtonGroup>
        ) : (
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            <Pencil className="size-3.5 shrink-0" />
            Edit
          </Button>
        )}
      </div>

      {canWrite && editing ? (
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={6}
          variant="accent"
          className="resize-y font-mono leading-relaxed"
          autoFocus
        />
      ) : (
        <pre className="bg-foreground/5 text-foreground max-h-[200px] overflow-auto rounded-md px-3 py-2.5 font-mono text-xs leading-relaxed whitespace-pre-wrap">
          {trigger.prompt_template}
        </pre>
      )}
      <p className="text-muted-foreground/70 text-xs leading-relaxed text-pretty">
        Placeholders: <code className="font-mono">{'{{ message.text }}'}</code>,{' '}
        <code className="font-mono">{'{{ message.source }}'}</code>,{' '}
        <code className="font-mono">{'{{ trigger.type }}'}</code>,{' '}
        <code className="font-mono">{'{{ fired_at }}'}</code>.
      </p>
    </section>
  );
}

function MetaSection({ trigger }: { trigger: ProjectTrigger }) {
  return (
    <section className="space-y-2">
      <Label>Properties</Label>
      <PropertyTable
        rows={[
          { label: 'Slug', value: <span className="font-mono text-xs">{trigger.slug}</span> },
          {
            label: 'Source file',
            value: <span className="font-mono text-xs">{trigger.path}</span>,
          },
          {
            label: 'Last fired',
            value: (
              <span className="text-xs tabular-nums">
                {trigger.last_fired_at ? new Date(trigger.last_fired_at).toLocaleString() : 'Never'}
              </span>
            ),
          },
        ]}
      />
    </section>
  );
}

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

type WizardStep = 'setup' | 'details';

function TriggerModalSection({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="space-y-0.5">
        <p className="text-foreground text-sm font-medium">{label}</p>
        {description ? (
          <p className="text-muted-foreground text-xs leading-relaxed text-pretty">{description}</p>
        ) : null}
      </div>
      {children}
    </section>
  );
}


function CreateTriggerModal({
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
  forcedType?: TriggerKind;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');

  const [step, setStep] = useState<WizardStep>('setup');
  const [sourceType, setSourceType] = useState<TriggerKind>(forcedType ?? 'cron');
  const [cronExpr, setCronExpr] = useState('0 0 9 * * *');
  const [runAt, setRunAt] = useState<string | null>(null);
  const [timezone, setTimezone] = useState('UTC');
  const [webhookSecret, setWebhookSecret] = useState('');

  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [agentName, setAgentName] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<ModelKey | null>(null);
  // Session strategy: how each fire uses sessions.
  const [sessionMode, setSessionMode] = useState<'fresh' | 'reuse' | 'pinned'>('fresh');
  const [pinnedSessionId, setPinnedSessionId] = useState<string | null>(null);
  // Sessions to choose from when pinning (only fetched once the user picks 'pinned').
  const pinnableSessions = useQuery({
    queryKey: ['project-sessions', projectId, 'trigger-pin'],
    queryFn: () => listProjectSessions(projectId),
    enabled: open && sessionMode === 'pinned',
    staleTime: 30_000,
  });

  const [error, setError] = useState<string | null>(null);

  const agents = useVisibleAgents({ projectId });
  const { data: providers } = useRuntimeProviders();
  const models = useMemo(() => flattenModels(providers), [providers]);

  useEffect(() => {
    if (!open) {
      setStep('setup');
      setSourceType(forcedType ?? 'cron');
      setCronExpr('0 0 9 * * *');
      setRunAt(null);
      setTimezone('UTC');
      setWebhookSecret('');
      setName('');
      setPrompt('');
      setAgentName(null);
      setSelectedModel(null);
      setError(null);
    }
  }, [open, forcedType]);

  const create = useMutation({
    mutationFn: async () => {
      const trimmedPrompt = prompt.trim();
      const trimmedName = name.trim();
      if (!trimmedName) throw new Error('Name is required');
      if (sourceType === 'cron') {
        if (runAt) {
          if (Number.isNaN(Date.parse(runAt))) throw new Error('Pick a valid date and time');
          if (Date.parse(runAt) <= Date.now()) throw new Error('Pick a time in the future');
        } else if (!cronExpr.trim()) {
          throw new Error('Cron expression is required');
        }
      }
      if (sourceType === 'webhook' && !webhookSecret.trim())
        throw new Error('Webhook secret is required');
      if (!trimmedPrompt) throw new Error('Prompt is required');

      const slug = slugifyName(trimmedName);

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
        ...(agentName ? { agent: agentName } : {}),
        ...(selectedModel ? { model: modelKeyToWire(selectedModel) } : {}),
        ...(sessionMode !== 'fresh' ? { session_mode: sessionMode } : {}),
        ...(sessionMode === 'pinned' && pinnedSessionId ? { session_id: pinnedSessionId } : {}),
        ...(sourceType === 'cron'
          ? runAt
            ? { run_at: runAt, timezone: timezone.trim() || 'UTC' }
            : { cron: cronExpr.trim(), timezone: timezone.trim() || 'UTC' }
          : { secret_env: secretEnv }),
      });
    },
    onSuccess: (listing) => {
      const created = listing.triggers
        .filter((t) => t.type === sourceType && t.name === name.trim())
        .slice(-1)[0];
      successToast('Trigger created', {
        description:
          sourceType === 'cron'
            ? runAt
              ? `Runs once on ${new Date(runAt).toLocaleString()}`
              : `Running on ${describeCron(cronExpr.trim())}`
            : 'Webhook URL ready in the detail panel',
      });
      if (created) onCreated(created.slug);
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Failed to create'),
  });

  function slugifyName(input: string): string {
    return (
      input
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/-{2,}/g, '-')
        .slice(0, 128) || 'trigger'
    );
  }

  const validate = (): string | null => {
    const setupError = validateSetup();
    if (setupError) return setupError;
    if (!name.trim()) return 'Name is required';
    if (!prompt.trim()) return 'Prompt is required';
    if (sessionMode === 'pinned' && !pinnedSessionId) return 'Pick a session to pin';
    return null;
  };

  const validateSetup = (): string | null => {
    if (sourceType === 'cron') {
      if (runAt) {
        if (Number.isNaN(Date.parse(runAt))) return 'Pick a valid date and time';
        if (Date.parse(runAt) <= Date.now()) return 'Pick a time in the future';
      } else if (!cronExpr.trim()) {
        return 'Cron expression is required';
      }
    }
    if (sourceType === 'webhook' && !webhookSecret.trim()) return 'Webhook secret is required';
    return null;
  };

  const isValid = (): boolean => validate() == null;

  const dialogTitle =
    forcedType === 'cron'
      ? 'New schedule'
      : forcedType === 'webhook'
        ? 'New webhook'
        : 'Create trigger';
  const dialogDescription =
    forcedType === 'cron'
      ? 'Set when this schedule fires and what it does.'
      : forcedType === 'webhook'
        ? 'Configure the signing secret, action, and identity for this webhook.'
        : 'Pick a source, set when it fires, and what it does.';
  const createButtonLabel =
    forcedType === 'cron'
      ? 'Create schedule'
      : forcedType === 'webhook'
        ? 'Create webhook'
        : 'Create trigger';
  const setupLabel = sourceType === 'cron' ? 'Schedule' : 'Webhook';
  const goToDetails = () => {
    const setupError = validateSetup();
    if (setupError) {
      setError(setupError);
      return;
    }
    setError(null);
    setStep('details');
  };

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (create.isPending) return;
        if (!next) onOpenChange(false);
      }}
    >
      <ModalContent className="gap-0 overflow-hidden p-0 sm:max-w-lg" modalClassName="lg:max-w-lg">
        <ModalHeader className="pb-1">
          <ModalTitle>{dialogTitle}</ModalTitle>
          <ModalDescription>{dialogDescription}</ModalDescription>
          <div
            className="flex items-center gap-2 pt-3"
            aria-label={`Step ${step === 'setup' ? 1 : 2} of 2`}
          >
            {[
              { id: 'setup', label: setupLabel },
              { id: 'details', label: 'Details' },
            ].map((item, index) => {
              const isCurrent = step === item.id;
              const isComplete = step === 'details' && index === 0;
              return (
                <div className="flex items-center gap-2" key={item.id}>
                  {index > 0 && <span className="bg-border h-px w-5" aria-hidden="true" />}
                  <span
                    className={cn(
                      'flex size-5 items-center justify-center rounded-full text-xs font-medium tabular-nums',
                      isCurrent
                        ? 'bg-primary text-primary-foreground'
                        : isComplete
                          ? 'bg-primary/10 text-primary'
                          : 'bg-muted text-muted-foreground',
                    )}
                  >
                    {isComplete ? <Check className="size-3" /> : index + 1}
                  </span>
                  <span
                    className={cn(
                      'text-xs',
                      isCurrent ? 'text-foreground font-medium' : 'text-muted-foreground',
                    )}
                  >
                    {item.label}
                  </span>
                </div>
              );
            })}
          </div>
        </ModalHeader>

        <ModalBody className="max-h-[min(64vh,600px)] space-y-6 overflow-y-auto px-5 py-5">
          {step === 'setup' && !forcedType && (
            <TriggerModalSection
              label="Trigger source"
              description="Choose what starts this automation."
            >
              <div className="overflow-hidden rounded-md">
                <SourceCard
                  icon={Timer}
                  title="Cron"
                  description={tHardcodedUi.raw(
                    'componentsProjectsTriggersView.line1085JsxAttrDescriptionTimeBasedSchedule',
                  )}
                  selected={sourceType === 'cron'}
                  onClick={() => setSourceType('cron')}
                />
                <SourceCard
                  icon={Webhook}
                  title="Webhook"
                  description={tHardcodedUi.raw(
                    'componentsProjectsTriggersView.line1092JsxAttrDescriptionFiresOnHttpRequest',
                  )}
                  selected={sourceType === 'webhook'}
                  onClick={() => setSourceType('webhook')}
                />
              </div>
            </TriggerModalSection>
          )}

          {step === 'setup' && sourceType === 'cron' && (
            <TriggerModalSection
              label="Schedule"
              description="Pick a recurring cadence or a one-time run."
            >
              <ScheduleBuilder
                value={cronExpr}
                onChange={setCronExpr}
                allowOnce
                runAt={runAt}
                onRunAtChange={setRunAt}
              />
              {!runAt && (
                <div className="flex items-center justify-between gap-3 pt-1">
                  <p className="text-muted-foreground text-xs text-pretty">
                    Times follow the selected timezone.
                  </p>
                  <Select value={timezone} onValueChange={setTimezone}>
                    <SelectTrigger
                      className="text-muted-foreground hover:text-foreground h-8 w-auto cursor-pointer gap-1.5 rounded-full border-none bg-transparent px-3 text-xs"
                      title="Timezone"
                    >
                      <AlarmClockSolid className="size-3.5" />
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
                </div>
              )}
            </TriggerModalSection>
          )}

          {step === 'setup' && sourceType === 'webhook' && (
            <TriggerModalSection
              label="Signing secret"
              description="Used to verify inbound requests before the trigger fires."
            >
              <WebhookSourceConfig secret={webhookSecret} onSecretChange={setWebhookSecret} />
            </TriggerModalSection>
          )}

          {step === 'setup' && error && (
            <InfoBanner tone="destructive" className="text-xs">
              {error}
            </InfoBanner>
          )}

          {step === 'details' && (
            <>
              <TriggerModalSection
                label="Name"
                description="Shown in the schedule or webhook list."
              >
                <Input
                  id="trigger-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={tHardcodedUi.raw(
                    'componentsProjectsTriggersView.line1151JsxAttrPlaceholderDailyStandupDigest',
                  )}
                  maxLength={64}
                  autoFocus
                />
              </TriggerModalSection>

              <TriggerModalSection
                label="Prompt"
                description="Spawn a session and send this instruction when the trigger fires."
              >
                <Textarea
                  id="trigger-prompt"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder={tHardcodedUi.raw(
                    'componentsProjectsTriggersView.line1162JsxAttrPlaceholderGenerateTheDailyStatusReportAndSaveIt',
                  )}
                  rows={5}
                />
                <p className="text-muted-foreground text-xs leading-relaxed text-pretty">
                  {tHardcodedUi.raw(
                    'componentsProjectsTriggersView.line1166JsxTextMustachePlaceholdersSupported',
                  )}{' '}
                  <code className="font-mono">{'{{ message.text }}'}</code>,{' '}
                  <code className="font-mono">{'{{ message.source }}'}</code>,{' '}
                  <code className="font-mono">{'{{ trigger.type }}'}</code>,{' '}
                  <code className="font-mono">{'{{ fired_at }}'}</code>.
                </p>
              </TriggerModalSection>

              <TriggerModalSection
                label="Agent"
                description="Which agent profile handles each run."
              >
                <div className="bg-card rounded-2xl border px-2 py-1">
                  <AgentSelector
                    agents={agents}
                    selectedAgent={agentName}
                    onSelect={setAgentName}
                  />
                </div>
              </TriggerModalSection>

              <TriggerModalSection
                label="Model"
                description="Overrides the agent's default model for this trigger's runs. Leave unset to use the agent's default."
              >
                <div className="bg-card rounded-2xl border px-2 py-1">
                  <ModelSelector
                    models={models}
                    providers={providers}
                    selectedModel={selectedModel}
                    onSelect={setSelectedModel}
                  />
                </div>
              </TriggerModalSection>

              <TriggerModalSection
                label="Session strategy"
                description="How each run uses sessions: a fresh one every time, loop this trigger's own session, or pin one specific existing session."
              >
                <div className="bg-card space-y-2 rounded-2xl border px-3 py-2">
                  <Select
                    value={sessionMode}
                    onValueChange={(v) => {
                      setSessionMode(v as 'fresh' | 'reuse' | 'pinned');
                      if (v !== 'pinned') setPinnedSessionId(null);
                    }}
                  >
                    <SelectTrigger className="h-9 w-full cursor-pointer text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="fresh" className="cursor-pointer">
                        New session each run
                      </SelectItem>
                      <SelectItem value="reuse" className="cursor-pointer">
                        Reuse this trigger&apos;s session (loop)
                      </SelectItem>
                      <SelectItem value="pinned" className="cursor-pointer">
                        Pin a specific session…
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  {sessionMode === 'pinned' && (
                    <Select
                      value={pinnedSessionId ?? ''}
                      onValueChange={setPinnedSessionId}
                      disabled={pinnableSessions.isLoading}
                    >
                      <SelectTrigger className="h-9 w-full cursor-pointer text-sm">
                        <SelectValue
                          placeholder={
                            pinnableSessions.isLoading
                              ? 'Loading sessions…'
                              : 'Choose a session to loop'
                          }
                        />
                      </SelectTrigger>
                      <SelectContent>
                        {(pinnableSessions.data ?? []).map((s) => (
                          <SelectItem
                            key={s.session_id}
                            value={s.session_id}
                            className="cursor-pointer"
                          >
                            {s.name || s.branch_name || s.session_id}
                          </SelectItem>
                        ))}
                        {!pinnableSessions.isLoading &&
                          (pinnableSessions.data ?? []).length === 0 && (
                            <div className="text-muted-foreground px-2 py-1.5 text-xs">
                              No sessions in this project yet.
                            </div>
                          )}
                      </SelectContent>
                    </Select>
                  )}
                </div>
              </TriggerModalSection>

              {error && (
                <InfoBanner tone="destructive" className="text-xs">
                  {error}
                </InfoBanner>
              )}
            </>
          )}
        </ModalBody>

        <ModalFooter className="mt-0 shrink-0 justify-between gap-2 px-5 py-4">
          {step === 'details' ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setStep('setup')}
              className="cursor-pointer"
            >
              <ArrowLeft className="size-4" />
              Back
            </Button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
              className="cursor-pointer"
            >
              Cancel
            </Button>
            {step === 'setup' ? (
              <Button size="sm" onClick={goToDetails} className="cursor-pointer">
                Continue
                <ArrowRight className="size-4" />
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={() => create.mutate()}
                disabled={!isValid() || create.isPending}
                className="cursor-pointer"
              >
                {create.isPending ? 'Creating…' : createButtonLabel}
              </Button>
            )}
          </div>
        </ModalFooter>
      </ModalContent>
    </Modal>
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
        'duration-normal ease-default flex h-auto w-full items-center gap-3 px-4 py-3.5 text-left transition-colors',
        selected ? 'bg-primary/6' : 'hover:bg-foreground/3',
      )}
    >
      <div
        className={cn(
          'flex size-8 shrink-0 items-center justify-center rounded-sm',
          selected ? 'bg-primary/10 text-primary' : 'bg-muted/40 text-muted-foreground',
        )}
      >
        <Icon className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-foreground text-sm font-medium">{title}</div>
        <div className="text-muted-foreground mt-0.5 text-xs text-pretty">{description}</div>
      </div>
      {selected && <Check className="text-primary size-4 shrink-0" />}
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
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>
          {tHardcodedUi.raw('componentsProjectsTriggersView.line1325JsxTextSigningSecret')}
        </Label>
        <div className="flex gap-2">
          <Input
            value={secret}
            onChange={(e) => onSecretChange(e.target.value)}
            placeholder="shared-secret"
            type="text"
            className="font-mono text-sm"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9 shrink-0 gap-1 px-3 text-xs"
            onClick={() => onSecretChange(generateSecret())}
          >
            <RefreshCw className="size-3" />
            Generate
          </Button>
        </div>
      </div>

      <div className="bg-muted/40 space-y-1.5 rounded-md p-4">
        <div className="text-muted-foreground text-xs font-medium">
          {tHardcodedUi.raw('componentsProjectsTriggersView.line1349JsxTextExternalUrl')}
        </div>
        <code className="text-foreground block font-mono text-xs break-all">
          {buildWebhookUrl('<trigger-id>')}
        </code>
        <p className="text-muted-foreground text-xs leading-relaxed text-pretty">
          {tHardcodedUi.raw(
            'componentsProjectsTriggersView.line1355JsxTextWeGenerateTheTriggerIdOnCreatePost',
          )}{' '}
          <code className="font-mono text-xs">X-Kortix-Signature</code>
          {tHardcodedUi.raw('componentsProjectsTriggersView.line1357JsxTextHeaderSetTo')}{' '}
          <code className="font-mono text-xs">
            {tHardcodedUi.raw('componentsProjectsTriggersView.line1359JsxTextSha256LtHmacGt')}
          </code>{' '}
          {tHardcodedUi.raw(
            'componentsProjectsTriggersView.line1360JsxTextComputedOverTheRawBodyWithTheSecret',
          )}
        </p>
      </div>
    </div>
  );
}

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
  const tHardcodedUi = useTranslations('hardcodedUi');
  const remove = useMutation({
    mutationFn: (trigger: ProjectTrigger) => deleteProjectTrigger(projectId, trigger.slug),
    onSuccess: () => {
      successToast('Trigger deleted');
      onDeleted();
    },
    onError: (err) => errorToast(err instanceof Error ? err.message : 'Failed to delete'),
  });

  return (
    <AlertDialog open={!!target} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {tHardcodedUi.raw('componentsProjectsTriggersView.line1394JsxTextDeleteTrigger')}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {target && (
              <>
                Remove <span className="text-foreground font-medium">{getTriggerName(target)}</span>{' '}
                {tHardcodedUi.raw(
                  'componentsProjectsTriggersView.line1402JsxTextAndStopAnyFutureRunsFromItPast',
                )}
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className={buttonVariants({ variant: 'destructive' })}
            onClick={() => target && remove.mutate(target)}
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

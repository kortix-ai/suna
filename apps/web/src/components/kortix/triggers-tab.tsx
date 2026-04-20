'use client';

/**
 * Project Triggers tab — list / create / run / pause / delete.
 * Engine untouched; this is a filtered view over the global triggers table.
 */

import { useMemo, useState } from 'react';
import {
  Plus, Play, Pause, Trash2, Loader2, Timer, Link2, CircleCheck, CircleX,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import {
  useProjectTriggers,
  useTriggerExecutions,
  useCreateProjectTrigger,
  useRunProjectTrigger,
  usePauseProjectTrigger,
  useDeleteProjectTrigger,
  type ProjectTrigger,
} from '@/hooks/kortix/use-project-triggers';
import { toast } from 'sonner';

const CADENCE_PRESETS: Array<{ label: string; cron: string }> = [
  { label: 'Every 15 min', cron: '0 */15 * * * *' },
  { label: 'Every 30 min', cron: '0 */30 * * * *' },
  { label: 'Every hour', cron: '0 0 * * * *' },
  { label: 'Daily 9am', cron: '0 0 9 * * *' },
  { label: 'Weekdays 9am', cron: '0 0 9 * * 1-5' },
  { label: 'Twice daily (9am, 5pm)', cron: '0 0 9,17 * * *' },
];

interface Props {
  projectId: string;
  projectPath: string;
}

export function TriggersTab({ projectId, projectPath }: Props) {
  const { data, isLoading } = useProjectTriggers(projectId);
  const triggers = data?.triggers ?? [];
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  return (
    <div className="h-full overflow-y-auto animate-in fade-in-0 duration-300 fill-mode-both">
      <div className="container mx-auto max-w-4xl px-4 sm:px-6 lg:px-10 py-8 sm:py-10 space-y-8">
        <section>
          <div className="flex items-center gap-2 mb-3">
            <Timer className="h-3.5 w-3.5 text-muted-foreground/45" />
            <span className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground/55 font-semibold">Project triggers</span>
            <div className="ml-auto">
              <Button
                variant="ghost" size="sm"
                className="h-6 px-2 text-[11px] gap-1 text-muted-foreground/60 hover:text-foreground"
                onClick={() => setCreateOpen(true)}
              >
                <Plus className="h-3 w-3" />
                New trigger
              </Button>
            </div>
          </div>
          <p className="text-[12px] text-muted-foreground/55 -mt-2 mb-3">
            Cron + webhook triggers scoped to this project. Engine runs them the same as workspace triggers;
            a mirror copy lives in <code className="font-mono text-[10.5px] px-1 py-0.5 rounded bg-muted/30">{projectPath}/.kortix/triggers.yaml</code>.
          </p>

          <div className="rounded-xl border border-border/40 divide-y divide-border/30 overflow-hidden bg-card">
            {isLoading && (
              <div className="py-8 text-center text-[12px] text-muted-foreground/50">Loading…</div>
            )}
            {!isLoading && triggers.length === 0 && (
              <div className="py-10 text-center text-[12px] text-muted-foreground/50">
                No triggers yet. The PM onboarding cadence question creates one automatically;
                you can also add more from here.
              </div>
            )}
            {triggers.map((t) => (
              <TriggerRow
                key={t.id}
                projectId={projectId}
                trigger={t}
                onOpen={() => setSelectedId(t.id === selectedId ? null : t.id)}
                expanded={selectedId === t.id}
              />
            ))}
          </div>
        </section>
      </div>

      <CreateTriggerDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        projectId={projectId}
      />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Row
// ═══════════════════════════════════════════════════════════════════════════

function TriggerRow({
  projectId, trigger, onOpen, expanded,
}: {
  projectId: string;
  trigger: ProjectTrigger;
  onOpen: () => void;
  expanded: boolean;
}) {
  const run = useRunProjectTrigger();
  const pause = usePauseProjectTrigger();
  const del = useDeleteProjectTrigger();

  const sourceLabel = useMemo(() => {
    if (trigger.source_type === 'cron') {
      return (trigger.source_config.cron_expr as string) || 'cron';
    }
    if (trigger.source_type === 'webhook') {
      const method = (trigger.source_config.method as string) || 'POST';
      const path = (trigger.source_config.path as string) || '';
      return `${method} ${path}`;
    }
    return trigger.source_type;
  }, [trigger]);

  return (
    <div>
      <div className="flex items-center gap-3 px-3 py-2.5">
        <button
          type="button"
          onClick={onOpen}
          className="flex-1 min-w-0 text-left flex items-center gap-3 cursor-pointer"
        >
          <span className={cn(
            'inline-flex items-center gap-1 h-5 px-1.5 rounded text-[10px] font-mono',
            trigger.is_active ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-muted/40 text-muted-foreground/60',
          )}>
            {trigger.is_active ? <CircleCheck className="h-2.5 w-2.5" /> : <CircleX className="h-2.5 w-2.5" />}
            {trigger.source_type}
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] font-medium truncate">{trigger.name}</div>
            <div className="text-[10.5px] text-muted-foreground/60 truncate font-mono">{sourceLabel}</div>
          </div>
          <div className="text-[10.5px] text-muted-foreground/50 shrink-0">
            {trigger.next_run_at ? `next: ${formatNext(trigger.next_run_at)}` : '—'}
          </div>
          <div className="text-[10.5px] text-muted-foreground/50 shrink-0 tabular-nums">
            {trigger.event_count}×
          </div>
        </button>
        <div className="flex items-center gap-0.5 shrink-0">
          <Button
            variant="ghost" size="sm"
            className="h-6 w-6 p-0 text-muted-foreground/40 hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation();
              run.mutate({ projectId, triggerId: trigger.id }, {
                onSuccess: () => toast.success('Trigger fired'),
                onError: (err) => toast.error(`Run failed: ${err instanceof Error ? err.message : String(err)}`),
              });
            }}
            disabled={run.isPending}
            title="Run now"
          >
            {run.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
          </Button>
          <Button
            variant="ghost" size="sm"
            className="h-6 w-6 p-0 text-muted-foreground/40 hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation();
              pause.mutate({ projectId, triggerId: trigger.id, resume: !trigger.is_active });
            }}
            disabled={pause.isPending}
            title={trigger.is_active ? 'Pause' : 'Resume'}
          >
            <Pause className={cn('h-3 w-3', !trigger.is_active && 'opacity-50')} />
          </Button>
          <Button
            variant="ghost" size="sm"
            className="h-6 w-6 p-0 text-muted-foreground/40 hover:text-destructive"
            onClick={(e) => {
              e.stopPropagation();
              if (confirm(`Delete trigger "${trigger.name}"?`)) {
                del.mutate({ projectId, triggerId: trigger.id });
              }
            }}
            disabled={del.isPending}
            title="Delete"
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </div>
      {expanded && <ExecutionsList projectId={projectId} triggerId={trigger.id} />}
    </div>
  );
}

function ExecutionsList({ projectId, triggerId }: { projectId: string; triggerId: string }) {
  const { data, isLoading } = useTriggerExecutions(projectId, triggerId);
  const rows = data?.executions ?? [];
  return (
    <div className="bg-muted/10 border-t border-border/20 px-3 py-2 text-[11px]">
      <div className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground/55 mb-1.5 font-semibold">Recent fires</div>
      {isLoading && <div className="text-muted-foreground/50">Loading…</div>}
      {!isLoading && rows.length === 0 && <div className="text-muted-foreground/50">No runs yet.</div>}
      {rows.slice(0, 10).map((r) => (
        <div key={r.id} className="flex items-center gap-2 py-0.5 font-mono">
          <span className={cn(
            'h-1.5 w-1.5 rounded-full shrink-0',
            r.status === 'completed' ? 'bg-emerald-500'
              : r.status === 'running' ? 'bg-amber-500'
              : r.status === 'failed' ? 'bg-destructive'
              : 'bg-muted-foreground/40',
          )} />
          <span className="text-muted-foreground/70 w-24 shrink-0">{r.started_at.slice(11, 19)}</span>
          <span className="w-16 shrink-0">{r.status}</span>
          <span className="w-16 shrink-0 text-muted-foreground/60">
            {r.duration_ms != null ? `${r.duration_ms}ms` : '—'}
          </span>
          {r.http_status != null && (
            <span className="w-12 shrink-0 text-muted-foreground/60">{r.http_status}</span>
          )}
          {r.error_message && (
            <span className="truncate text-destructive/80 flex-1">{r.error_message}</span>
          )}
        </div>
      ))}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Create dialog — cron + prompt or http action
// ═══════════════════════════════════════════════════════════════════════════

function CreateTriggerDialog({
  open, onOpenChange, projectId,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  projectId: string;
}) {
  const create = useCreateProjectTrigger();
  const [name, setName] = useState('');
  const [cron, setCron] = useState(CADENCE_PRESETS[2].cron); // every hour default
  const [actionType, setActionType] = useState<'prompt' | 'http'>('prompt');
  const [prompt, setPrompt] = useState('');
  const [agent, setAgent] = useState('project-manager');
  const [url, setUrl] = useState('');

  const canSubmit = name.trim() && cron.trim() && (
    (actionType === 'prompt' && prompt.trim()) ||
    (actionType === 'http' && url.trim())
  );

  const submit = () => {
    if (!canSubmit) return;
    create.mutate({
      projectId,
      input: {
        name: name.trim(),
        source: { type: 'cron', cron_expr: cron.trim(), timezone: 'UTC' },
        action: actionType === 'prompt'
          ? { type: 'prompt', prompt: prompt.trim(), agent: agent.trim() || undefined }
          : { type: 'http', url: url.trim() },
      },
    }, {
      onSuccess: () => {
        toast.success(`Trigger "${name}" created`);
        onOpenChange(false);
        setName(''); setPrompt(''); setUrl('');
      },
      onError: (err) => toast.error(`Create failed: ${err instanceof Error ? err.message : String(err)}`),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New project trigger</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <Field label="Name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="daily-board-summary"
              className="h-8 w-full text-[12.5px] bg-muted/30 border border-border/40 rounded px-2 outline-none focus:ring-2 focus:ring-primary/20"
            />
          </Field>

          <Field label="Cadence">
            <Select value={cron} onValueChange={setCron}>
              <SelectTrigger size="sm" className="h-8 w-full text-[12px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CADENCE_PRESETS.map((p) => (
                  <SelectItem key={p.cron} value={p.cron}>
                    {p.label} <span className="ml-2 font-mono text-[10.5px] opacity-55">{p.cron}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <input
              value={cron}
              onChange={(e) => setCron(e.target.value)}
              placeholder="0 0 9 * * *"
              className="mt-1.5 h-7 w-full text-[11px] font-mono bg-muted/20 border border-border/30 rounded px-2 outline-none focus:ring-2 focus:ring-primary/20"
            />
            <p className="text-[10.5px] text-muted-foreground/55 mt-1">
              6-field cron (seconds minutes hours day month weekday). Pick a preset or edit inline.
            </p>
          </Field>

          <Field label="Action">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setActionType('prompt')}
                className={cn(
                  'h-7 px-3 rounded text-[11.5px] border transition-colors',
                  actionType === 'prompt' ? 'border-primary bg-primary/10 text-foreground' : 'border-border/40 text-muted-foreground/70 hover:text-foreground',
                )}
              >prompt</button>
              <button
                type="button"
                onClick={() => setActionType('http')}
                className={cn(
                  'h-7 px-3 rounded text-[11.5px] border transition-colors',
                  actionType === 'http' ? 'border-primary bg-primary/10 text-foreground' : 'border-border/40 text-muted-foreground/70 hover:text-foreground',
                )}
              >http</button>
            </div>
          </Field>

          {actionType === 'prompt' && (
            <>
              <Field label="Agent">
                <input
                  value={agent}
                  onChange={(e) => setAgent(e.target.value)}
                  placeholder="project-manager"
                  className="h-8 w-full text-[12.5px] bg-muted/30 border border-border/40 rounded px-2 font-mono outline-none focus:ring-2 focus:ring-primary/20"
                />
              </Field>
              <Field label="Prompt">
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  rows={6}
                  placeholder="What should this agent do when the trigger fires?"
                  className="w-full text-[12px] bg-muted/30 border border-border/40 rounded px-2 py-1.5 outline-none focus:ring-2 focus:ring-primary/20 resize-y"
                />
              </Field>
            </>
          )}

          {actionType === 'http' && (
            <Field label="URL">
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="http://localhost:8000/kortix/projects/.../pm-review"
                className="h-8 w-full text-[12px] font-mono bg-muted/30 border border-border/40 rounded px-2 outline-none focus:ring-2 focus:ring-primary/20"
              />
            </Field>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            size="sm"
            onClick={submit}
            disabled={!canSubmit || create.isPending}
            className="gap-1"
          >
            {create.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Link2 className="h-3 w-3" />}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[10.5px] uppercase tracking-[0.08em] text-muted-foreground/55 font-semibold mb-1">{label}</span>
      {children}
    </label>
  );
}

function formatNext(iso: string): string {
  try {
    const d = new Date(iso);
    const diff = d.getTime() - Date.now();
    if (diff < 0) return 'now';
    const mins = Math.round(diff / 60000);
    if (mins < 60) return `${mins}m`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h`;
    return `${Math.round(hrs / 24)}d`;
  } catch { return '—'; }
}

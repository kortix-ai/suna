'use client';

import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Plus,
  Trash2,
  ArrowUp,
  ArrowDown,
  Save,
  Loader2,
  Columns as ColumnsIcon,
  SlidersHorizontal,
  FileStack,
  Pause,
  Play,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import {
  useColumns,
  useReplaceColumns,
  useFields,
  useReplaceFields,
  useTemplates,
  useReplaceTemplates,
  useProjectAgents,
  type TicketColumn,
  type ProjectField,
  type ProjectAgent,
} from '@/hooks/kortix/use-kortix-tickets';
import { COLUMN_ICONS, COLUMN_ICON_KEYS, defaultColumnIcon } from '@/components/kortix/ticket-board';

type Panel = 'columns' | 'fields' | 'templates';

const TRIGGER_CLS = cn(
  'data-[state=active]:shadow-none',
  'data-[state=active]:ring-0',
  'data-[state=active]:bg-background data-[state=active]:text-foreground',
  'data-[state=active]:border-border/60',
);

const INPUT_CLS =
  'h-8 rounded-lg bg-muted/40 border-0 px-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground/40 transition-colors focus:bg-muted/60 focus:ring-2 focus:ring-ring/20';

export function TicketSettingsTab({ projectId }: { projectId: string }) {
  const [panel, setPanel] = useState<Panel>('columns');
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-4 sm:px-6 py-8 space-y-8">
        <Tabs value={panel} onValueChange={(v) => setPanel(v as Panel)}>
          <TabsList>
            <TabsTrigger value="columns" className={cn('flex-none px-3', TRIGGER_CLS)}>
              <ColumnsIcon />
              Columns
            </TabsTrigger>
            <TabsTrigger value="fields" className={cn('flex-none px-3', TRIGGER_CLS)}>
              <SlidersHorizontal />
              Custom fields
            </TabsTrigger>
            <TabsTrigger value="templates" className={cn('flex-none px-3', TRIGGER_CLS)}>
              <FileStack />
              Templates
            </TabsTrigger>
          </TabsList>
        </Tabs>

        <motion.div
          key={panel}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
        >
          {panel === 'columns' && <ColumnsEditor projectId={projectId} />}
          {panel === 'fields' && <FieldsEditor projectId={projectId} />}
          {panel === 'templates' && <TemplatesEditor projectId={projectId} />}
        </motion.div>
      </div>
    </div>
  );
}

function SectionHead({
  icon: Icon,
  label,
  count,
  description,
  action,
}: {
  icon: typeof ColumnsIcon;
  label: string;
  count?: number;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-3">
      <div className="flex items-center gap-2">
        <Icon className="size-3.5 text-muted-foreground/60" />
        <h2 className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">{label}</h2>
        {typeof count === 'number' && (
          <span className="text-xs tabular-nums text-muted-foreground/45">{count}</span>
        )}
        {action && <div className="ml-auto">{action}</div>}
      </div>
      <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{description}</p>
    </div>
  );
}

interface ColumnDraft {
  key: string;
  label: string;
  default_assignee_type: 'agent' | null;
  default_assignee_id: string | null;
  is_terminal: boolean;
  is_off_flow: boolean;
  icon: string | null;
}

function ColumnsEditor({ projectId }: { projectId: string }) {
  const { data: columnsData } = useColumns(projectId);
  const { data: agentsData } = useProjectAgents(projectId);
  const agents = useMemo(() => agentsData ?? [], [agentsData]);
  const replace = useReplaceColumns();
  const [drafts, setDrafts] = useState<ColumnDraft[]>([]);
  useEffect(() => { if (columnsData) setDrafts(columnsData.map(toColumnDraft)); }, [columnsData]);

  const dirty = useMemo(
    () => JSON.stringify(drafts.map(toColumnKeyShape)) !== JSON.stringify((columnsData ?? []).map(toColumnKey)),
    [drafts, columnsData],
  );

  const flowRows = useMemo(
    () => drafts.map((d, idx) => ({ d, idx })).filter((r) => !r.d.is_off_flow),
    [drafts],
  );
  const offFlowRows = useMemo(
    () => drafts.map((d, idx) => ({ d, idx })).filter((r) => r.d.is_off_flow),
    [drafts],
  );

  const addFlowColumn = () => setDrafts((ds) => [...ds, {
    key: `col_${Date.now().toString(36)}`, label: 'New column',
    default_assignee_type: null, default_assignee_id: null, is_terminal: false, is_off_flow: false, icon: null,
  }]);
  const addOffFlowColumn = () => setDrafts((ds) => [...ds, {
    key: `col_${Date.now().toString(36)}`, label: 'New side-channel',
    default_assignee_type: null, default_assignee_id: null, is_terminal: false, is_off_flow: true, icon: 'pause',
  }]);
  const removeAt = (i: number) => setDrafts((ds) => ds.filter((_, idx) => idx !== i));
  const patchAt = (i: number, patch: Partial<ColumnDraft>) =>
    setDrafts((ds) => ds.map((d, idx) => idx === i ? { ...d, ...patch } : d));
  const toggleOffFlow = (i: number) =>
    setDrafts((ds) => ds.map((d, idx) => idx === i ? { ...d, is_off_flow: !d.is_off_flow } : d));

  const moveFlowUp = (draftIdx: number) => setDrafts((ds) => {
    let prev = -1;
    for (let k = draftIdx - 1; k >= 0; k--) if (!ds[k].is_off_flow) { prev = k; break; }
    if (prev === -1) return ds;
    const next = [...ds];
    [next[prev], next[draftIdx]] = [next[draftIdx], next[prev]];
    return next;
  });
  const moveFlowDown = (draftIdx: number) => setDrafts((ds) => {
    let nxt = -1;
    for (let k = draftIdx + 1; k < ds.length; k++) if (!ds[k].is_off_flow) { nxt = k; break; }
    if (nxt === -1) return ds;
    const next = [...ds];
    [next[draftIdx], next[nxt]] = [next[nxt], next[draftIdx]];
    return next;
  });

  const save = () => {
    const ordered = [
      ...drafts.filter((d) => !d.is_off_flow),
      ...drafts.filter((d) => d.is_off_flow),
    ];
    replace.mutate({ projectId, columns: ordered });
  };

  return (
    <section className="space-y-8">
      <div>
        <SectionHead
          icon={ColumnsIcon}
          label="Flow"
          count={flowRows.length}
          description="The linear sequence tickets move through. Order matters — new tickets land in the first column. Click a column's icon to change it."
          action={
            <Button
              variant="ghost"
              size="sm"
              onClick={addFlowColumn}
              className="h-7 text-xs text-muted-foreground hover:text-foreground"
            >
              <Plus />
              Add column
            </Button>
          }
        />

        <div className="overflow-hidden rounded-2xl bg-muted/30">
          {flowRows.length === 0 && (
            <div className="px-4 py-10 text-center text-sm text-muted-foreground/60">
              No flow columns yet.
            </div>
          )}
          {flowRows.map(({ d, idx }, displayI) => (
            <ColumnRow
              key={idx}
              draft={d}
              agents={agents}
              onPatch={(patch) => patchAt(idx, patch)}
              onDelete={() => removeAt(idx)}
              onToggleOffFlow={() => toggleOffFlow(idx)}
              isLast={displayI === flowRows.length - 1}
              canMoveUp={displayI > 0}
              canMoveDown={displayI < flowRows.length - 1}
              onMoveUp={() => moveFlowUp(idx)}
              onMoveDown={() => moveFlowDown(idx)}
            />
          ))}
        </div>
      </div>

      <div>
        <SectionHead
          icon={Pause}
          label="Off-flow"
          count={offFlowRows.length}
          description="Side-channel columns (e.g. blocked, on hold). Reachable from any flow column but don't participate in the linear sequence."
          action={
            <Button
              variant="ghost"
              size="sm"
              onClick={addOffFlowColumn}
              className="h-7 text-xs text-muted-foreground hover:text-foreground"
            >
              <Plus />
              Add side-channel
            </Button>
          }
        />

        <div className="overflow-hidden rounded-2xl bg-muted/30">
          {offFlowRows.length === 0 && (
            <div className="px-4 py-10 text-center text-sm text-muted-foreground/60">
              No side-channels. Tickets that stall on external input can stay in a flow column, or you can add one like blocked.
            </div>
          )}
          {offFlowRows.map(({ d, idx }, displayI) => (
            <ColumnRow
              key={idx}
              draft={d}
              agents={agents}
              onPatch={(patch) => patchAt(idx, patch)}
              onDelete={() => removeAt(idx)}
              onToggleOffFlow={() => toggleOffFlow(idx)}
              isLast={displayI === offFlowRows.length - 1}
            />
          ))}
        </div>
      </div>

      <SaveRow disabled={!dirty} submitting={replace.isPending} onSave={save} />
    </section>
  );
}

function ColumnRow({
  draft: d, agents, onPatch, onDelete, onToggleOffFlow,
  isLast,
  canMoveUp, canMoveDown, onMoveUp, onMoveDown,
}: {
  draft: ColumnDraft;
  agents: ProjectAgent[];
  onPatch: (patch: Partial<ColumnDraft>) => void;
  onDelete: () => void;
  onToggleOffFlow: () => void;
  isLast: boolean;
  canMoveUp?: boolean; canMoveDown?: boolean;
  onMoveUp?: () => void; onMoveDown?: () => void;
}) {
  const isOffFlow = d.is_off_flow;
  return (
    <div className={cn(
      'group flex items-center gap-2 px-3 py-2.5 transition-colors hover:bg-muted/40',
      !isLast && 'border-b border-border/40',
    )}>
      <ColumnIconPicker
        iconKey={d.icon ?? defaultColumnIcon(d.key)}
        onChange={(k) => onPatch({ icon: k })}
      />
      <input
        value={d.label}
        onChange={(e) => onPatch({ label: e.target.value })}
        placeholder="Label"
        className="h-8 flex-1 rounded-lg border-0 bg-transparent px-2 text-sm font-medium outline-none placeholder:text-muted-foreground/40 focus:bg-muted/40 focus:ring-2 focus:ring-ring/20"
      />
      <input
        value={d.key}
        onChange={(e) => onPatch({ key: e.target.value.toLowerCase().replace(/\s+/g, '_') })}
        placeholder="key"
        className={cn(INPUT_CLS, 'w-[120px]')}
      />
      <Select
        value={d.default_assignee_id ?? '_none'}
        onValueChange={(v) => onPatch(v === '_none'
          ? { default_assignee_type: null, default_assignee_id: null }
          : { default_assignee_type: 'agent', default_assignee_id: v })}
      >
        <SelectTrigger size="sm" className="h-8 w-[140px] text-sm">
          <SelectValue placeholder="No default" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="_none">No default</SelectItem>
          {agents.map((a) => <SelectItem key={a.id} value={a.id}>@{a.slug}</SelectItem>)}
        </SelectContent>
      </Select>
      <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        {!isOffFlow && (
          <>
            <RowIconButton
              onClick={onMoveUp}
              disabled={!canMoveUp}
              title="Move up"
              icon={<ArrowUp className="size-3.5" />}
            />
            <RowIconButton
              onClick={onMoveDown}
              disabled={!canMoveDown}
              title="Move down"
              icon={<ArrowDown className="size-3.5" />}
            />
          </>
        )}
        <RowIconButton
          onClick={onToggleOffFlow}
          title={isOffFlow ? 'Move back to flow' : 'Move to off-flow'}
          icon={isOffFlow ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
        />
        <RowIconButton
          onClick={onDelete}
          title="Delete column"
          icon={<Trash2 className="size-3.5" />}
          destructive
        />
      </div>
    </div>
  );
}

function RowIconButton({
  onClick,
  disabled,
  title,
  icon,
  destructive,
}: {
  onClick?: () => void;
  disabled?: boolean;
  title: string;
  icon: React.ReactNode;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className={cn(
        'inline-flex size-7 items-center justify-center rounded-md transition-colors',
        'text-muted-foreground/60 hover:bg-muted hover:text-foreground',
        'disabled:pointer-events-none disabled:opacity-30',
        destructive && 'hover:text-destructive',
      )}
    >
      {icon}
    </button>
  );
}

function toColumnDraft(c: TicketColumn): ColumnDraft {
  return {
    key: c.key,
    label: c.label,
    default_assignee_type: c.default_assignee_type === 'agent' ? 'agent' : null,
    default_assignee_id: c.default_assignee_id,
    is_terminal: c.is_terminal === 1,
    is_off_flow: c.is_off_flow === 1,
    icon: c.icon ?? null,
  };
}
function toColumnKeyShape(d: ColumnDraft) { return { ...d }; }
function toColumnKey(c: TicketColumn) {
  return {
    key: c.key, label: c.label,
    default_assignee_type: c.default_assignee_type === 'agent' ? 'agent' : null,
    default_assignee_id: c.default_assignee_id,
    is_terminal: c.is_terminal === 1,
    is_off_flow: c.is_off_flow === 1,
    icon: c.icon ?? null,
  };
}

function ColumnIconPicker({ iconKey, onChange }: { iconKey: string; onChange: (k: string) => void }) {
  const entry = COLUMN_ICONS[iconKey] ?? COLUMN_ICONS.backlog;
  const Ic = entry.Icon;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
          title="Change icon"
          aria-label="Change column icon"
        >
          <Ic className={cn('size-4', entry.tint)} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56 z-[10000]">
        <DropdownMenuLabel className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground/60 font-semibold">
          Column icon
        </DropdownMenuLabel>
        <div className="grid grid-cols-4 gap-1 p-1.5">
          {COLUMN_ICON_KEYS.map((k) => {
            const c = COLUMN_ICONS[k];
            const I = c.Icon;
            const active = k === iconKey;
            return (
              <DropdownMenuItem
                key={k}
                onClick={() => onChange(k)}
                className={cn(
                  'flex h-12 cursor-pointer flex-col items-center justify-center gap-0.5 p-1',
                  active && 'bg-muted/60',
                )}
                title={c.label}
              >
                <I className={cn('size-4', c.tint)} />
                <span className="max-w-full truncate text-[10px] text-muted-foreground/70">{c.label}</span>
              </DropdownMenuItem>
            );
          })}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface FieldDraft {
  key: string;
  label: string;
  type: 'text' | 'number' | 'date' | 'select';
  options: string[];
}

function FieldsEditor({ projectId }: { projectId: string }) {
  const { data: fieldsData } = useFields(projectId);
  const replace = useReplaceFields();
  const [drafts, setDrafts] = useState<FieldDraft[]>([]);
  useEffect(() => { if (fieldsData) setDrafts(fieldsData.map(toFieldDraft)); }, [fieldsData]);

  const dirty = useMemo(
    () => JSON.stringify(drafts) !== JSON.stringify((fieldsData ?? []).map(toFieldDraft)),
    [drafts, fieldsData],
  );

  const add = () => setDrafts((ds) => [...ds, {
    key: `field_${Date.now().toString(36)}`, label: 'New field', type: 'text', options: [],
  }]);
  const removeAt = (i: number) => setDrafts((ds) => ds.filter((_, idx) => idx !== i));
  const patchAt = (i: number, patch: Partial<FieldDraft>) =>
    setDrafts((ds) => ds.map((d, idx) => idx === i ? { ...d, ...patch } : d));

  const save = () => replace.mutate({
    projectId,
    fields: drafts.map((d) => ({
      key: d.key, label: d.label, type: d.type,
      options: d.type === 'select' ? d.options : null,
    })),
  });

  return (
    <section>
      <SectionHead
        icon={SlidersHorizontal}
        label="Custom fields"
        count={drafts.length}
        description="Per-project fields shown on every ticket. Type controls the editor — text, number, date, or a select with predefined options."
        action={
          <Button
            variant="ghost"
            size="sm"
            onClick={add}
            className="h-7 text-xs text-muted-foreground hover:text-foreground"
          >
            <Plus />
            Add field
          </Button>
        }
      />

      <div className="overflow-hidden rounded-2xl bg-muted/30">
        {drafts.length === 0 && (
          <div className="px-4 py-10 text-center text-sm text-muted-foreground/60">
            No custom fields yet.
          </div>
        )}
        {drafts.map((d, i) => (
          <div
            key={i}
            className={cn(
              'group px-3 py-3 transition-colors hover:bg-muted/40',
              i !== drafts.length - 1 && 'border-b border-border/40',
            )}
          >
            <div className="flex items-center gap-2">
              <input
                value={d.label}
                onChange={(e) => patchAt(i, { label: e.target.value })}
                placeholder="Label"
                className="h-8 flex-1 rounded-lg border-0 bg-transparent px-2 text-sm font-medium outline-none placeholder:text-muted-foreground/40 focus:bg-muted/40 focus:ring-2 focus:ring-ring/20"
              />
              <input
                value={d.key}
                onChange={(e) => patchAt(i, { key: e.target.value.toLowerCase().replace(/\s+/g, '_') })}
                placeholder="key"
                className={cn(INPUT_CLS, 'w-[120px]')}
              />
              <Select value={d.type} onValueChange={(v) => patchAt(i, { type: v as FieldDraft['type'] })}>
                <SelectTrigger size="sm" className="h-8 w-[110px] text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="text">Text</SelectItem>
                  <SelectItem value="number">Number</SelectItem>
                  <SelectItem value="date">Date</SelectItem>
                  <SelectItem value="select">Select</SelectItem>
                </SelectContent>
              </Select>
              <div className="opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                <RowIconButton
                  onClick={() => removeAt(i)}
                  title="Delete field"
                  icon={<Trash2 className="size-3.5" />}
                  destructive
                />
              </div>
            </div>
            {d.type === 'select' && (
              <input
                value={d.options.join(', ')}
                onChange={(e) => patchAt(i, {
                  options: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
                })}
                placeholder="Options, comma-separated — e.g. P0, P1, P2, P3"
                className={cn(INPUT_CLS, 'mt-2 w-full h-8')}
              />
            )}
          </div>
        ))}
      </div>

      <SaveRow disabled={!dirty} submitting={replace.isPending} onSave={save} />
    </section>
  );
}

function toFieldDraft(f: ProjectField): FieldDraft {
  let options: string[] = [];
  try { options = f.options_json ? JSON.parse(f.options_json) : []; } catch {}
  return { key: f.key, label: f.label, type: f.type, options };
}

interface TemplateDraft { name: string; body_md: string }

function TemplatesEditor({ projectId }: { projectId: string }) {
  const { data: templatesData } = useTemplates(projectId);
  const replace = useReplaceTemplates();
  const [drafts, setDrafts] = useState<TemplateDraft[]>([]);
  const [active, setActive] = useState<number | null>(null);
  useEffect(() => {
    if (templatesData) setDrafts(templatesData.map((t) => ({ name: t.name, body_md: t.body_md })));
  }, [templatesData]);

  const dirty = useMemo(
    () => JSON.stringify(drafts) !== JSON.stringify((templatesData ?? []).map((t) => ({ name: t.name, body_md: t.body_md }))),
    [drafts, templatesData],
  );

  const add = () => {
    const next = drafts.length;
    setDrafts((ds) => [...ds, {
      name: 'Bug',
      body_md: '## Summary\n\n## Steps to reproduce\n\n## Expected\n\n## Actual\n\n## Acceptance criteria\n- [ ] …',
    }]);
    setActive(next);
  };
  const removeAt = (i: number) => {
    setDrafts((ds) => ds.filter((_, idx) => idx !== i));
    setActive((a) => (a === null ? null : a === i ? null : a > i ? a - 1 : a));
  };
  const patchAt = (i: number, patch: Partial<TemplateDraft>) =>
    setDrafts((ds) => ds.map((d, idx) => idx === i ? { ...d, ...patch } : d));

  const save = () => replace.mutate({ projectId, templates: drafts });

  return (
    <section>
      <SectionHead
        icon={FileStack}
        label="Ticket templates"
        count={drafts.length}
        description="Markdown templates shown in the New-ticket picker. Acceptance criteria lives in the body — no hardcoded verification field."
        action={
          <Button
            variant="ghost"
            size="sm"
            onClick={add}
            className="h-7 text-xs text-muted-foreground hover:text-foreground"
          >
            <Plus />
            Add template
          </Button>
        }
      />

      <div className="overflow-hidden rounded-2xl bg-muted/30">
        {drafts.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-muted-foreground/60">
            No templates yet.
          </div>
        ) : (
          <div className="flex min-h-[360px]">
            <div className="w-52 shrink-0 border-r border-border/40">
              {drafts.map((d, i) => (
                <button
                  key={i}
                  onClick={() => setActive(i)}
                  className={cn(
                    'group block w-full cursor-pointer px-3 py-2.5 text-left transition-colors hover:bg-muted/60',
                    i !== drafts.length - 1 && 'border-b border-border/40',
                    active === i && 'bg-muted/60',
                  )}
                >
                  <div className="truncate text-sm font-medium text-foreground">
                    {d.name || 'Untitled'}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-muted-foreground/55">
                    {summarise(d.body_md)}
                  </div>
                </button>
              ))}
            </div>
            <div className="flex min-w-0 flex-1 flex-col bg-background">
              {active === null ? (
                <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground/60">
                  Select a template to edit, or add a new one.
                </div>
              ) : (
                <>
                  <div className="group flex items-center gap-2 border-b border-border/40 px-3 py-2">
                    <input
                      value={drafts[active].name}
                      onChange={(e) => patchAt(active, { name: e.target.value })}
                      placeholder="Name (e.g. Bug)"
                      className="h-8 flex-1 rounded-lg border-0 bg-transparent px-2 text-sm font-semibold outline-none placeholder:text-muted-foreground/40 focus:bg-muted/40 focus:ring-2 focus:ring-ring/20"
                    />
                    <div className="opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                      <RowIconButton
                        onClick={() => removeAt(active)}
                        title="Delete template"
                        icon={<Trash2 className="size-3.5" />}
                        destructive
                      />
                    </div>
                  </div>
                  <textarea
                    value={drafts[active].body_md}
                    onChange={(e) => patchAt(active, { body_md: e.target.value })}
                    rows={14}
                    className="flex-1 resize-none border-0 bg-transparent px-3 py-2.5 text-sm leading-relaxed outline-none placeholder:text-muted-foreground/40 focus:ring-0"
                    placeholder="Markdown body…"
                  />
                </>
              )}
            </div>
          </div>
        )}
      </div>

      <SaveRow disabled={!dirty} submitting={replace.isPending} onSave={save} />
    </section>
  );
}

function summarise(body: string): string {
  const clean = (body || '').replace(/^#+\s*/gm, '').replace(/\s+/g, ' ').trim();
  if (!clean) return 'Empty';
  return clean.length > 40 ? `${clean.slice(0, 40)}…` : clean;
}

function SaveRow({ disabled, submitting, onSave }: { disabled: boolean; submitting: boolean; onSave: () => void }) {
  return (
    <div className="mt-4 flex items-center justify-end">
      <Button
        size="sm"
        disabled={disabled || submitting}
        onClick={onSave}
        className="gap-1.5"
      >
        {submitting ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
        {disabled ? 'Saved' : 'Save changes'}
      </Button>
    </div>
  );
}

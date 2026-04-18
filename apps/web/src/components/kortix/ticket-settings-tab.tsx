'use client';

/**
 * Ticket Settings tab — Columns, Custom Fields, Templates.
 *
 * Matches Project About styling: max-w-3xl container, small uppercase section
 * labels, rounded cards on bg-card, row-based lists with dividers.
 * Each panel replaces the whole list on Save — server stays authoritative.
 */

import { useEffect, useMemo, useState } from 'react';
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
  Check,
  ChevronDown,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
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

export function TicketSettingsTab({ projectId }: { projectId: string }) {
  const [panel, setPanel] = useState<Panel>('columns');
  return (
    <div className="h-full overflow-y-auto animate-in fade-in-0 duration-300 fill-mode-both">
      <div className="container mx-auto max-w-3xl px-4 sm:px-6 lg:px-10 py-8 sm:py-10 space-y-8">

        <nav className="flex items-center gap-1 -ml-2">
          <NavTab active={panel === 'columns'} onClick={() => setPanel('columns')} icon={<ColumnsIcon className="h-3.5 w-3.5" />} label="Columns" />
          <NavTab active={panel === 'fields'} onClick={() => setPanel('fields')} icon={<SlidersHorizontal className="h-3.5 w-3.5" />} label="Custom fields" />
          <NavTab active={panel === 'templates'} onClick={() => setPanel('templates')} icon={<FileStack className="h-3.5 w-3.5" />} label="Templates" />
        </nav>

        {panel === 'columns' && <ColumnsEditor projectId={projectId} />}
        {panel === 'fields' && <FieldsEditor projectId={projectId} />}
        {panel === 'templates' && <TemplatesEditor projectId={projectId} />}
      </div>
    </div>
  );
}

function NavTab({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full text-[12px] transition-colors cursor-pointer',
        active
          ? 'bg-foreground text-background'
          : 'text-muted-foreground/70 hover:text-foreground hover:bg-muted/40',
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function SectionHead({ icon, label, description, action }: {
  icon: React.ReactNode; label: string; description: string; action?: React.ReactNode;
}) {
  return (
    <>
      <div className="flex items-center gap-2 mb-3">
        {icon}
        <span className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground/55 font-semibold">{label}</span>
        {action && <div className="ml-auto">{action}</div>}
      </div>
      <p className="text-[12px] text-muted-foreground/55 -mt-2 mb-3">{description}</p>
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Columns
// ═══════════════════════════════════════════════════════════════════════════

interface ColumnDraft {
  key: string;
  label: string;
  default_assignee_type: 'agent' | null;
  default_assignee_id: string | null;
  is_terminal: boolean;
  icon: string | null;
}

function ColumnsEditor({ projectId }: { projectId: string }) {
  const { data: columnsData } = useColumns(projectId);
  const { data: agentsData } = useProjectAgents(projectId);
  const agents = useMemo(() => agentsData ?? [], [agentsData]);
  const replace = useReplaceColumns();
  const [drafts, setDrafts] = useState<ColumnDraft[]>([]);
  useEffect(() => { if (columnsData) setDrafts(columnsData.map(toColumnDraft)); }, [columnsData]);

  const dirty = useMemo(() => JSON.stringify(drafts.map(toColumnDraftKey)) !== JSON.stringify((columnsData ?? []).map(toColumnKey)), [drafts, columnsData]);

  const addColumn = () => setDrafts((ds) => [...ds, {
    key: `col_${Date.now().toString(36)}`, label: 'New column',
    default_assignee_type: null, default_assignee_id: null, is_terminal: false, icon: null,
  }]);
  const removeAt = (i: number) => setDrafts((ds) => ds.filter((_, idx) => idx !== i));
  const moveAt = (i: number, dir: -1 | 1) => setDrafts((ds) => {
    const j = i + dir;
    if (j < 0 || j >= ds.length) return ds;
    const next = [...ds]; [next[i], next[j]] = [next[j], next[i]]; return next;
  });
  const patchAt = (i: number, patch: Partial<ColumnDraft>) => setDrafts((ds) => ds.map((d, idx) => idx === i ? { ...d, ...patch } : d));

  const save = () => replace.mutate({ projectId, columns: drafts });

  return (
    <section>
      <SectionHead
        icon={<ColumnsIcon className="h-3.5 w-3.5 text-muted-foreground/45" />}
        label="Columns"
        description="Define the board's flow. Order matters — new tickets land in the first column. Click a column's icon to change it."
        action={
          <Button
            variant="ghost" size="sm" className="h-6 px-2 text-[11px] gap-1 text-muted-foreground/60 hover:text-foreground"
            onClick={addColumn}
          >
            <Plus className="h-3 w-3" />
            Add column
          </Button>
        }
      />

      <div className="rounded-xl border border-border/40 divide-y divide-border/30 overflow-hidden bg-card">
        {drafts.length === 0 && (
          <div className="py-8 text-center text-[12px] text-muted-foreground/50">No columns yet.</div>
        )}
        {drafts.map((d, i) => (
          <div key={i} className="flex items-center gap-2 px-3 py-2.5">
            <ColumnIconPicker
              iconKey={d.icon ?? defaultColumnIcon(d.key)}
              onChange={(k) => patchAt(i, { icon: k })}
            />
            <input
              value={d.label}
              onChange={(e) => patchAt(i, { label: e.target.value })}
              placeholder="Label"
              className="h-7 flex-1 text-[12.5px] bg-transparent border-0 outline-none focus:ring-0 placeholder:text-muted-foreground/30"
            />
            <input
              value={d.key}
              onChange={(e) => patchAt(i, { key: e.target.value.toLowerCase().replace(/\s+/g, '_') })}
              placeholder="key"
              className="h-6 w-[110px] text-[10.5px] font-mono bg-muted/30 border border-border/30 rounded px-2 outline-none focus:ring-2 focus:ring-primary/20"
            />
            <Select
              value={d.default_assignee_id ?? '_none'}
              onValueChange={(v) => patchAt(i, v === '_none'
                ? { default_assignee_type: null, default_assignee_id: null }
                : { default_assignee_type: 'agent', default_assignee_id: v })}
            >
              <SelectTrigger size="sm" className="h-6 text-[11px] w-[130px]"><SelectValue placeholder="Default…" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="_none">No default</SelectItem>
                {agents.map((a) => <SelectItem key={a.id} value={a.id}>@{a.slug}</SelectItem>)}
              </SelectContent>
            </Select>
            <div className="flex items-center gap-0.5 ml-1">
              <Button variant="ghost" size="sm" className="h-6 w-6 p-0 text-muted-foreground/40 hover:text-foreground" onClick={() => moveAt(i, -1)}><ArrowUp className="h-3 w-3" /></Button>
              <Button variant="ghost" size="sm" className="h-6 w-6 p-0 text-muted-foreground/40 hover:text-foreground" onClick={() => moveAt(i, 1)}><ArrowDown className="h-3 w-3" /></Button>
              <Button variant="ghost" size="sm" className="h-6 w-6 p-0 text-muted-foreground/40 hover:text-destructive" onClick={() => removeAt(i)}><Trash2 className="h-3 w-3" /></Button>
            </div>
          </div>
        ))}
      </div>

      <SaveRow disabled={!dirty} submitting={replace.isPending} onSave={save} />
    </section>
  );
}

function toColumnDraft(c: TicketColumn): ColumnDraft {
  return {
    key: c.key,
    label: c.label,
    default_assignee_type: c.default_assignee_type === 'agent' ? 'agent' : null,
    default_assignee_id: c.default_assignee_id,
    is_terminal: c.is_terminal === 1,
    icon: c.icon ?? null,
  };
}
function toColumnDraftKey(d: ColumnDraft) { return { ...d }; }
function toColumnKey(c: TicketColumn) {
  return {
    key: c.key, label: c.label,
    default_assignee_type: c.default_assignee_type === 'agent' ? 'agent' : null,
    default_assignee_id: c.default_assignee_id,
    is_terminal: c.is_terminal === 1,
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
          className="w-7 h-7 rounded-md flex items-center justify-center shrink-0 hover:bg-muted/40 transition-colors cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
          title="Change icon"
          aria-label="Change column icon"
        >
          <Ic className={cn('h-4 w-4', entry.tint)} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[220px] z-[10000]">
        <DropdownMenuLabel className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground/55 font-semibold">Column icon</DropdownMenuLabel>
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
                  'flex flex-col items-center justify-center gap-0.5 h-12 cursor-pointer p-1',
                  active && 'bg-muted/40',
                )}
                title={c.label}
              >
                <I className={cn('h-3.5 w-3.5', c.tint)} />
                <span className="text-[9.5px] text-muted-foreground/70 truncate max-w-full">{c.label}</span>
              </DropdownMenuItem>
            );
          })}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Fields
// ═══════════════════════════════════════════════════════════════════════════

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

  const dirty = useMemo(() => JSON.stringify(drafts) !== JSON.stringify((fieldsData ?? []).map(toFieldDraft)), [drafts, fieldsData]);

  const add = () => setDrafts((ds) => [...ds, { key: `field_${Date.now().toString(36)}`, label: 'New field', type: 'text', options: [] }]);
  const removeAt = (i: number) => setDrafts((ds) => ds.filter((_, idx) => idx !== i));
  const patchAt = (i: number, patch: Partial<FieldDraft>) => setDrafts((ds) => ds.map((d, idx) => idx === i ? { ...d, ...patch } : d));

  const save = () => replace.mutate({
    projectId,
    fields: drafts.map((d) => ({ key: d.key, label: d.label, type: d.type, options: d.type === 'select' ? d.options : null })),
  });

  return (
    <section>
      <SectionHead
        icon={<SlidersHorizontal className="h-3.5 w-3.5 text-muted-foreground/45" />}
        label="Custom fields"
        description="Per-project fields shown on every ticket. Type controls the editor — text, number, date, or a select with predefined options."
        action={
          <Button
            variant="ghost" size="sm"
            className="h-6 px-2 text-[11px] gap-1 text-muted-foreground/60 hover:text-foreground"
            onClick={add}
          >
            <Plus className="h-3 w-3" />
            Add field
          </Button>
        }
      />

      <div className="rounded-xl border border-border/40 divide-y divide-border/30 overflow-hidden bg-card">
        {drafts.length === 0 && (
          <div className="py-8 text-center text-[12px] text-muted-foreground/50">No custom fields yet.</div>
        )}
        {drafts.map((d, i) => (
          <div key={i} className="px-3 py-3">
            <div className="flex items-center gap-2">
              <input
                value={d.label}
                onChange={(e) => patchAt(i, { label: e.target.value })}
                placeholder="Label"
                className="h-7 flex-1 text-[12.5px] bg-transparent border-0 outline-none focus:ring-0 placeholder:text-muted-foreground/30"
              />
              <input
                value={d.key}
                onChange={(e) => patchAt(i, { key: e.target.value.toLowerCase().replace(/\s+/g, '_') })}
                placeholder="key"
                className="h-6 w-[110px] text-[10.5px] font-mono bg-muted/30 border border-border/30 rounded px-2 outline-none focus:ring-2 focus:ring-primary/20"
              />
              <Select value={d.type} onValueChange={(v) => patchAt(i, { type: v as FieldDraft['type'] })}>
                <SelectTrigger size="sm" className="h-6 text-[11px] w-[100px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="text">text</SelectItem>
                  <SelectItem value="number">number</SelectItem>
                  <SelectItem value="date">date</SelectItem>
                  <SelectItem value="select">select</SelectItem>
                </SelectContent>
              </Select>
              <Button variant="ghost" size="sm" className="h-6 w-6 p-0 text-muted-foreground/40 hover:text-destructive" onClick={() => removeAt(i)}><Trash2 className="h-3 w-3" /></Button>
            </div>
            {d.type === 'select' && (
              <input
                value={d.options.join(', ')}
                onChange={(e) => patchAt(i, { options: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
                placeholder="Options, comma-separated — e.g. P0, P1, P2, P3"
                className="mt-2 h-7 w-full text-[11.5px] bg-muted/20 border border-border/30 rounded-lg px-2.5 outline-none focus:ring-2 focus:ring-primary/20"
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

// ═══════════════════════════════════════════════════════════════════════════
// Templates
// ═══════════════════════════════════════════════════════════════════════════

interface TemplateDraft { name: string; body_md: string }

function TemplatesEditor({ projectId }: { projectId: string }) {
  const { data: templatesData } = useTemplates(projectId);
  const replace = useReplaceTemplates();
  const [drafts, setDrafts] = useState<TemplateDraft[]>([]);
  const [active, setActive] = useState<number | null>(null);
  useEffect(() => {
    if (templatesData) setDrafts(templatesData.map((t) => ({ name: t.name, body_md: t.body_md })));
  }, [templatesData]);

  const dirty = useMemo(() => JSON.stringify(drafts) !== JSON.stringify((templatesData ?? []).map((t) => ({ name: t.name, body_md: t.body_md }))), [drafts, templatesData]);

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
  const patchAt = (i: number, patch: Partial<TemplateDraft>) => setDrafts((ds) => ds.map((d, idx) => idx === i ? { ...d, ...patch } : d));

  const save = () => replace.mutate({ projectId, templates: drafts });

  return (
    <section>
      <SectionHead
        icon={<FileStack className="h-3.5 w-3.5 text-muted-foreground/45" />}
        label="Ticket templates"
        description="Markdown templates shown in the New-ticket picker. Acceptance criteria lives in the body — no hardcoded verification field."
        action={
          <Button
            variant="ghost" size="sm"
            className="h-6 px-2 text-[11px] gap-1 text-muted-foreground/60 hover:text-foreground"
            onClick={add}
          >
            <Plus className="h-3 w-3" />
            Add template
          </Button>
        }
      />

      <div className="rounded-xl border border-border/40 overflow-hidden bg-card">
        {drafts.length === 0 ? (
          <div className="py-8 text-center text-[12px] text-muted-foreground/50">No templates yet.</div>
        ) : (
          <div className="flex min-h-[320px]">
            <div className="w-48 border-r border-border/30 divide-y divide-border/30 shrink-0">
              {drafts.map((d, i) => (
                <button
                  key={i}
                  onClick={() => setActive(i)}
                  className={cn(
                    'w-full text-left px-3 py-2.5 hover:bg-muted/25 transition-colors cursor-pointer',
                    active === i && 'bg-muted/40',
                  )}
                >
                  <div className="text-[12.5px] font-medium truncate">{d.name || 'Untitled'}</div>
                  <div className="text-[10.5px] text-muted-foreground/45 truncate mt-0.5">
                    {summarise(d.body_md)}
                  </div>
                </button>
              ))}
            </div>
            <div className="flex-1 min-w-0 flex flex-col">
              {active === null ? (
                <div className="flex-1 flex items-center justify-center text-[12px] text-muted-foreground/45">
                  Select a template to edit, or add a new one.
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-2 px-3 py-2 border-b border-border/30">
                    <input
                      value={drafts[active].name}
                      onChange={(e) => patchAt(active, { name: e.target.value })}
                      placeholder="Name (e.g. Bug)"
                      className="h-7 flex-1 text-[12.5px] bg-transparent border-0 outline-none focus:ring-0 placeholder:text-muted-foreground/30 font-medium"
                    />
                    <Button
                      variant="ghost" size="sm"
                      className="h-6 w-6 p-0 text-muted-foreground/40 hover:text-destructive"
                      onClick={() => removeAt(active)}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                  <textarea
                    value={drafts[active].body_md}
                    onChange={(e) => patchAt(active, { body_md: e.target.value })}
                    rows={14}
                    className="flex-1 text-[12px] font-mono bg-transparent border-0 outline-none focus:ring-0 resize-none px-3 py-2.5 leading-[1.7] placeholder:text-muted-foreground/30"
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

// ═══════════════════════════════════════════════════════════════════════════
// Save row
// ═══════════════════════════════════════════════════════════════════════════

function SaveRow({ disabled, submitting, onSave }: { disabled: boolean; submitting: boolean; onSave: () => void }) {
  return (
    <div className="mt-3 flex items-center justify-end gap-2">
      <Button
        size="sm"
        className="h-7 px-3 text-[12px] gap-1"
        disabled={disabled || submitting}
        onClick={onSave}
      >
        {submitting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
        {disabled ? 'Saved' : 'Save changes'}
      </Button>
    </div>
  );
}

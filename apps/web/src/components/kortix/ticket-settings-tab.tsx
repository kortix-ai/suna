'use client';

/**
 * Settings tab — columns, custom fields, ticket templates.
 *
 * Each sub-panel is a simple replace-the-whole-list form: Save sends the full
 * array back. Keeps the UI dumb and the server the single source of truth.
 */

import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, ArrowUp, ArrowDown, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  useColumns,
  useReplaceColumns,
  useFields,
  useReplaceFields,
  useTemplates,
  useReplaceTemplates,
  useProjectAgents,
  safeParseJsonArray,
  type TicketColumn,
  type ProjectField,
  type TicketTemplate,
  type ProjectAgent,
} from '@/hooks/kortix/use-kortix-tickets';

type Panel = 'columns' | 'fields' | 'templates';

export function TicketSettingsTab({ projectId }: { projectId: string }) {
  const [panel, setPanel] = useState<Panel>('columns');
  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="container mx-auto max-w-5xl px-4 py-6">
        <div className="flex items-center gap-1.5 mb-5 border-b border-border/50">
          {(['columns', 'fields', 'templates'] as Panel[]).map((p) => (
            <button
              key={p}
              onClick={() => setPanel(p)}
              className={`relative h-9 px-3 text-[13px] font-medium tracking-tight capitalize transition-colors cursor-pointer ${panel === p ? 'text-foreground' : 'text-muted-foreground/60 hover:text-foreground'}`}
            >
              {p}
              {panel === p && <span className="absolute inset-x-2 bottom-0 h-[2px] bg-foreground rounded-full" />}
            </button>
          ))}
        </div>

        {panel === 'columns' && <ColumnsEditor projectId={projectId} />}
        {panel === 'fields' && <FieldsEditor projectId={projectId} />}
        {panel === 'templates' && <TemplatesEditor projectId={projectId} />}
      </div>
    </div>
  );
}

// ─── Columns ────────────────────────────────────────────────────────────────

interface ColumnDraft {
  key: string;
  label: string;
  default_assignee_type: 'agent' | null;
  default_assignee_id: string | null;
  is_terminal: boolean;
}

function ColumnsEditor({ projectId }: { projectId: string }) {
  const { data: columnsData } = useColumns(projectId);
  const { data: agentsData } = useProjectAgents(projectId);
  const agents = useMemo(() => agentsData ?? [], [agentsData]);
  const replace = useReplaceColumns();
  const [drafts, setDrafts] = useState<ColumnDraft[]>([]);
  useEffect(() => {
    if (columnsData) setDrafts(columnsData.map(toColumnDraft));
  }, [columnsData]);

  const addColumn = () => setDrafts((ds) => [...ds, {
    key: `col_${Date.now().toString(36)}`, label: 'New column',
    default_assignee_type: null, default_assignee_id: null, is_terminal: false,
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
    <PanelShell title="Columns" description="Define the board's flow. Order matters — first column is where new tickets land.">
      <div className="space-y-2">
        {drafts.map((d, i) => (
          <div key={i} className="flex items-center gap-2 p-2.5 rounded-lg border border-border/50 bg-card">
            <input
              value={d.key}
              onChange={(e) => patchAt(i, { key: e.target.value.toLowerCase().replace(/\s+/g, '_') })}
              placeholder="key"
              className="h-7 w-[140px] text-[11px] font-mono bg-transparent border border-border/40 rounded px-2 outline-none focus:ring-2 focus:ring-primary/20"
            />
            <input
              value={d.label}
              onChange={(e) => patchAt(i, { label: e.target.value })}
              placeholder="Label"
              className="h-7 flex-1 text-[12px] bg-transparent border border-border/40 rounded px-2 outline-none focus:ring-2 focus:ring-primary/20"
            />
            <Select
              value={d.default_assignee_id ?? '_none'}
              onValueChange={(v) => patchAt(i, v === '_none'
                ? { default_assignee_type: null, default_assignee_id: null }
                : { default_assignee_type: 'agent', default_assignee_id: v })}
            >
              <SelectTrigger size="sm" className="h-7 text-[11px] w-[160px]"><SelectValue placeholder="No default" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="_none">No default assignee</SelectItem>
                {agents.map((a) => <SelectItem key={a.id} value={a.id}>Default: @{a.slug}</SelectItem>)}
              </SelectContent>
            </Select>
            <label className="flex items-center gap-1 text-[11px] text-muted-foreground/70">
              <input type="checkbox" checked={d.is_terminal} onChange={(e) => patchAt(i, { is_terminal: e.target.checked })} />
              terminal
            </label>
            <div className="flex items-center gap-0.5 ml-auto">
              <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => moveAt(i, -1)}><ArrowUp className="h-3 w-3" /></Button>
              <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => moveAt(i, 1)}><ArrowDown className="h-3 w-3" /></Button>
              <Button variant="ghost" size="sm" className="h-6 w-6 p-0 text-destructive" onClick={() => removeAt(i)}><Trash2 className="h-3 w-3" /></Button>
            </div>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 mt-4">
        <Button variant="ghost" size="sm" onClick={addColumn} className="h-7 text-[12px]">
          <Plus className="h-3.5 w-3.5 mr-1" />Add column
        </Button>
        <Button size="sm" onClick={save} disabled={replace.isPending} className="ml-auto h-7 text-[12px]">
          <Save className="h-3.5 w-3.5 mr-1.5" />Save columns
        </Button>
      </div>
    </PanelShell>
  );
}

function toColumnDraft(c: TicketColumn): ColumnDraft {
  return {
    key: c.key,
    label: c.label,
    default_assignee_type: c.default_assignee_type === 'agent' ? 'agent' : null,
    default_assignee_id: c.default_assignee_id,
    is_terminal: c.is_terminal === 1,
  };
}

// ─── Fields ─────────────────────────────────────────────────────────────────

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
  useEffect(() => {
    if (fieldsData) setDrafts(fieldsData.map(toFieldDraft));
  }, [fieldsData]);

  const add = () => setDrafts((ds) => [...ds, { key: `field_${Date.now().toString(36)}`, label: 'New field', type: 'text', options: [] }]);
  const removeAt = (i: number) => setDrafts((ds) => ds.filter((_, idx) => idx !== i));
  const patchAt = (i: number, patch: Partial<FieldDraft>) => setDrafts((ds) => ds.map((d, idx) => idx === i ? { ...d, ...patch } : d));

  const save = () => replace.mutate({
    projectId,
    fields: drafts.map((d) => ({ key: d.key, label: d.label, type: d.type, options: d.type === 'select' ? d.options : null })),
  });

  return (
    <PanelShell title="Custom fields" description="Per-project fields shown on every ticket. Type = how the value is edited.">
      <div className="space-y-2">
        {drafts.map((d, i) => (
          <div key={i} className="p-2.5 rounded-lg border border-border/50 bg-card space-y-2">
            <div className="flex items-center gap-2">
              <input
                value={d.key}
                onChange={(e) => patchAt(i, { key: e.target.value.toLowerCase().replace(/\s+/g, '_') })}
                placeholder="key"
                className="h-7 w-[140px] text-[11px] font-mono bg-transparent border border-border/40 rounded px-2 outline-none focus:ring-2 focus:ring-primary/20"
              />
              <input
                value={d.label}
                onChange={(e) => patchAt(i, { label: e.target.value })}
                placeholder="Label"
                className="h-7 flex-1 text-[12px] bg-transparent border border-border/40 rounded px-2 outline-none focus:ring-2 focus:ring-primary/20"
              />
              <Select value={d.type} onValueChange={(v) => patchAt(i, { type: v as FieldDraft['type'] })}>
                <SelectTrigger size="sm" className="h-7 text-[11px] w-[120px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="text">text</SelectItem>
                  <SelectItem value="number">number</SelectItem>
                  <SelectItem value="date">date</SelectItem>
                  <SelectItem value="select">select</SelectItem>
                </SelectContent>
              </Select>
              <Button variant="ghost" size="sm" className="h-6 w-6 p-0 text-destructive ml-auto" onClick={() => removeAt(i)}><Trash2 className="h-3 w-3" /></Button>
            </div>
            {d.type === 'select' && (
              <input
                value={d.options.join(', ')}
                onChange={(e) => patchAt(i, { options: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
                placeholder="Options, comma-separated (e.g. P0, P1, P2, P3)"
                className="h-7 w-full text-[11px] bg-transparent border border-border/40 rounded px-2 outline-none focus:ring-2 focus:ring-primary/20"
              />
            )}
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 mt-4">
        <Button variant="ghost" size="sm" onClick={add} className="h-7 text-[12px]"><Plus className="h-3.5 w-3.5 mr-1" />Add field</Button>
        <Button size="sm" onClick={save} disabled={replace.isPending} className="ml-auto h-7 text-[12px]">
          <Save className="h-3.5 w-3.5 mr-1.5" />Save fields
        </Button>
      </div>
    </PanelShell>
  );
}

function toFieldDraft(f: ProjectField): FieldDraft {
  let options: string[] = [];
  try { options = f.options_json ? JSON.parse(f.options_json) : []; } catch {}
  return { key: f.key, label: f.label, type: f.type, options };
}

// ─── Templates ──────────────────────────────────────────────────────────────

interface TemplateDraft { name: string; body_md: string }

function TemplatesEditor({ projectId }: { projectId: string }) {
  const { data: templatesData } = useTemplates(projectId);
  const replace = useReplaceTemplates();
  const [drafts, setDrafts] = useState<TemplateDraft[]>([]);
  useEffect(() => {
    if (templatesData) setDrafts(templatesData.map((t) => ({ name: t.name, body_md: t.body_md })));
  }, [templatesData]);

  const add = () => setDrafts((ds) => [...ds, {
    name: 'Bug',
    body_md: `## Summary\n\n## Steps to reproduce\n\n## Expected\n\n## Actual\n\n## Acceptance criteria\n- [ ] …`,
  }]);
  const removeAt = (i: number) => setDrafts((ds) => ds.filter((_, idx) => idx !== i));
  const patchAt = (i: number, patch: Partial<TemplateDraft>) => setDrafts((ds) => ds.map((d, idx) => idx === i ? { ...d, ...patch } : d));

  const save = () => replace.mutate({ projectId, templates: drafts });

  return (
    <PanelShell title="Ticket templates" description="Markdown templates the creator picks from. Acceptance criteria lives in the body — no hardcoded verification field.">
      <div className="space-y-3">
        {drafts.map((d, i) => (
          <div key={i} className="p-3 rounded-lg border border-border/50 bg-card">
            <div className="flex items-center gap-2">
              <input
                value={d.name}
                onChange={(e) => patchAt(i, { name: e.target.value })}
                placeholder="Template name (Bug, Feature…)"
                className="h-7 flex-1 text-[12px] bg-transparent border border-border/40 rounded px-2 outline-none focus:ring-2 focus:ring-primary/20"
              />
              <Button variant="ghost" size="sm" className="h-6 w-6 p-0 text-destructive" onClick={() => removeAt(i)}><Trash2 className="h-3 w-3" /></Button>
            </div>
            <textarea
              value={d.body_md}
              onChange={(e) => patchAt(i, { body_md: e.target.value })}
              rows={8}
              className="mt-2 w-full text-[12px] font-mono bg-transparent border border-border/40 rounded px-2 py-2 outline-none focus:ring-2 focus:ring-primary/20 resize-none"
            />
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 mt-4">
        <Button variant="ghost" size="sm" onClick={add} className="h-7 text-[12px]"><Plus className="h-3.5 w-3.5 mr-1" />Add template</Button>
        <Button size="sm" onClick={save} disabled={replace.isPending} className="ml-auto h-7 text-[12px]">
          <Save className="h-3.5 w-3.5 mr-1.5" />Save templates
        </Button>
      </div>
    </PanelShell>
  );
}

// ─── Shell ──────────────────────────────────────────────────────────────────

function PanelShell({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-4">
        <h3 className="text-[13px] font-semibold tracking-tight">{title}</h3>
        <p className="text-[12px] text-muted-foreground/60 mt-0.5">{description}</p>
      </div>
      {children}
    </div>
  );
}

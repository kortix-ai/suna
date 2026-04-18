'use client';

/**
 * Team tab — single-column roster that matches the Project About design
 * language (max-w-3xl container, uppercase section labels, rounded-xl cards
 * on bg-card with border-border/40, row dividers for list items).
 */

import { useEffect, useMemo, useRef, useState, useLayoutEffect } from 'react';
import {
  Plus,
  UserCircle2,
  Bot,
  Trash2,
  Save,
  Pencil,
  X,
  Loader2,
  Check,
  ShieldCheck,
  Users,
  ChevronDown,
  Zap,
  Cpu,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  useProjectAgents,
  useCreateProjectAgent,
  useUpdateProjectAgent,
  useDeleteProjectAgent,
  useAgentPersona,
  useColumns,
  useUserHandle,
  safeParseJsonArray,
  type ProjectAgent,
  type ExecutionMode,
  type ToolGroup,
} from '@/hooks/kortix/use-kortix-tickets';
import { useOpenCodeProviders } from '@/hooks/opencode/use-opencode-sessions';
import { flattenModels, type FlatModel } from '@/components/session/session-chat-input';

const DEFAULT_PROMPT = `You are a team agent for this project.
Describe your responsibilities, your flow, and what you own.

When you're done with a ticket, move it to the next column using ticket_update_status.
Use team_list and project_context_read to ground yourself before acting.`;

export function TeamTab({ projectId }: { projectId: string }) {
  const { data: agents = [] } = useProjectAgents(projectId);
  const { data: columns = [] } = useColumns(projectId);
  const userHandle = useUserHandle();
  const [createOpen, setCreateOpen] = useState(false);
  const [editSlug, setEditSlug] = useState<string | null>(null);

  return (
    <div className="h-full overflow-y-auto animate-in fade-in-0 duration-300 fill-mode-both">
      <div className="container mx-auto max-w-3xl px-4 sm:px-6 lg:px-10 py-8 sm:py-10 space-y-8">

        {/* ─── Roster ─── */}
        <section>
          <div className="flex items-center gap-2 mb-3">
            <Users className="h-3.5 w-3.5 text-muted-foreground/45" />
            <span className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground/55 font-semibold">Team</span>
            <span className="text-[10px] text-muted-foreground/30 tabular-nums">{agents.length + 1}</span>
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto h-6 px-2 text-[11px] text-muted-foreground/60 hover:text-foreground gap-1"
              onClick={() => setCreateOpen(true)}
            >
              <Plus className="h-3 w-3" />
              New agent
            </Button>
          </div>

          <div className="rounded-xl border border-border/40 divide-y divide-border/30 overflow-hidden bg-card">
            <UserRow handle={userHandle} />
            {agents.length === 0 ? (
              <button
                onClick={() => setCreateOpen(true)}
                className="w-full py-8 text-center hover:bg-muted/20 transition-colors cursor-pointer"
              >
                <p className="text-[12.5px] text-foreground/70 font-medium mb-0.5">No agents yet</p>
                <p className="text-[11.5px] text-muted-foreground/50">Add the first team agent for this project.</p>
              </button>
            ) : (
              agents.map((a) => (
                <AgentRow key={a.id} agent={a} onClick={() => setEditSlug(a.slug)} />
              ))
            )}
          </div>
        </section>

        {/* ─── Notes ─── */}
        <section>
          <SectionLabel label="How it works" icon={<ShieldCheck className="h-3.5 w-3.5 text-muted-foreground/45" />} />
          <div className="rounded-xl border border-border/40 bg-card px-4 py-3 text-[12.5px] leading-relaxed text-muted-foreground/80 space-y-2">
            <p>
              <span className="text-foreground/90">Contributors</span> can comment, update custom fields,
              assign, and move tickets between columns. <span className="text-foreground/90">Orchestrators</span>
              additionally configure columns, fields, templates, and the team roster.
            </p>
            <p>
              Each agent has an execution mode — <code className="font-mono text-[11px] bg-muted/40 px-1 rounded">per_ticket</code>
              {' '}reuses one session per ticket (concurrent mentions queue), <code className="font-mono text-[11px] bg-muted/40 px-1 rounded">per_assignment</code> spawns a fresh session each time.
            </p>
          </div>
        </section>
      </div>

      <CreateAgentDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        projectId={projectId}
        columns={columns}
      />
      <EditAgentDialog
        slug={editSlug}
        onClose={() => setEditSlug(null)}
        projectId={projectId}
        columns={columns}
      />
    </div>
  );
}

function SectionLabel({ label, icon }: { label: string; icon?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 mb-2">
      {icon}
      <span className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground/55 font-semibold">{label}</span>
    </div>
  );
}

// ─── Rows ───────────────────────────────────────────────────────────────────

function UserRow({ handle }: { handle: string }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
        <UserCircle2 className="h-3.5 w-3.5 text-primary" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[13px] font-semibold truncate">@{handle}</span>
          <span className="text-[10px] text-muted-foreground/40">real human</span>
        </div>
        <p className="text-[11.5px] text-muted-foreground/55 truncate">
          Agents tag @{handle} when a decision is needed.
        </p>
      </div>
    </div>
  );
}

function AgentRow({ agent, onClick }: { agent: ProjectAgent; onClick: () => void }) {
  const groups = safeParseJsonArray(agent.tool_groups_json);
  const cols = safeParseJsonArray(agent.default_assignee_columns_json);
  const isOrchestrator = groups.includes('project_manage');

  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 px-4 py-3 hover:bg-muted/20 transition-colors cursor-pointer text-left group"
    >
      <div className="w-7 h-7 rounded-full bg-muted/50 flex items-center justify-center shrink-0">
        <Bot className="h-3.5 w-3.5 text-muted-foreground/65" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[13px] font-semibold truncate">@{agent.slug}</span>
          <span className="text-[11.5px] text-muted-foreground/50 truncate">{agent.name}</span>
        </div>
        <div className="flex items-center gap-1.5 mt-1 flex-wrap">
          <span className={`inline-flex items-center h-4 px-1.5 rounded text-[10px] font-medium ${isOrchestrator ? 'bg-primary/10 text-primary' : 'bg-muted/50 text-muted-foreground/80'}`}>
            {isOrchestrator ? 'orchestrator' : 'contributor'}
          </span>
          <span className="inline-flex items-center h-4 px-1.5 rounded text-[10px] font-mono bg-muted/40 text-muted-foreground/70">
            {agent.execution_mode}
          </span>
          {cols.map((c) => (
            <span key={c} className="inline-flex items-center h-4 px-1.5 rounded text-[10px] bg-emerald-500/10 text-emerald-400/80">
              default: {c}
            </span>
          ))}
        </div>
      </div>
      <Pencil className="h-3.5 w-3.5 text-muted-foreground/25 group-hover:text-foreground transition-colors" />
    </button>
  );
}

// ─── Shared agent form state ───────────────────────────────────────────────

interface AgentFormState {
  name: string;
  body_md: string;
  mode: ExecutionMode;
  canManage: boolean;
  defaultCol: string;
  defaultModel: string;
}

type ExecutionChoice = 'per_ticket' | 'new_session';

const EXECUTION_LABELS: Record<ExecutionChoice, string> = {
  per_ticket: 'Per-ticket',
  new_session: 'New session',
};
const EXECUTION_DESCRIPTIONS: Record<ExecutionChoice, string> = {
  per_ticket: 'Reuse one session per ticket. Notifications queue into it.',
  new_session: 'Spawn a fresh session on every assignment or mention.',
};

function modeToChoice(m: ExecutionMode): ExecutionChoice {
  return m === 'per_assignment' ? 'new_session' : 'per_ticket';
}
function choiceToMode(c: ExecutionChoice): ExecutionMode {
  return c === 'new_session' ? 'per_assignment' : 'per_ticket';
}

// ─── Create dialog ───────────────────────────────────────────────────────────

function CreateAgentDialog({ open, onClose, projectId, columns }: {
  open: boolean; onClose: () => void; projectId: string; columns: Array<{ key: string; label: string }>;
}) {
  const create = useCreateProjectAgent();
  const [slug, setSlug] = useState('');
  const [state, setState] = useState<AgentFormState>({
    name: '', body_md: DEFAULT_PROMPT, mode: 'per_ticket',
    canManage: false, defaultCol: '_none', defaultModel: '',
  });

  useEffect(() => {
    if (open) {
      setSlug('');
      setState({ name: '', body_md: DEFAULT_PROMPT, mode: 'per_ticket', canManage: false, defaultCol: '_none', defaultModel: '' });
    }
  }, [open]);

  const submit = () => {
    if (!slug.trim() || !state.name.trim()) return;
    const groups: ToolGroup[] = state.canManage ? ['project_manage', 'project_action'] : ['project_action'];
    const defaults = state.defaultCol === '_none' ? [] : [state.defaultCol];
    create.mutate({
      projectId, slug: slug.trim(), name: state.name.trim(), body_md: state.body_md,
      execution_mode: state.mode, tool_groups: groups, default_assignee_columns: defaults,
      default_model: state.defaultModel.trim() || null,
    }, { onSuccess: onClose });
  };

  return (
    <AgentFormDialog
      open={open}
      onOpenChange={(o) => { if (!o) onClose(); }}
      title="New team agent"
      footerLeft={`Writes .kortix/agents/${slug || 'slug'}.md`}
      submitLabel="Create"
      submitIcon={create.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
      submitDisabled={!slug.trim() || !state.name.trim() || create.isPending}
      onSubmit={submit}
      onCancel={onClose}
    >
      <AgentFormBody
        columns={columns}
        state={state}
        setState={setState}
        slug={slug}
        onSlugChange={(v) => setSlug(v.toLowerCase().replace(/[^a-z0-9-_]/g, '-'))}
      />
    </AgentFormDialog>
  );
}

// ─── Edit dialog ────────────────────────────────────────────────────────────

function EditAgentDialog({ slug, onClose, projectId, columns }: {
  slug: string | null; onClose: () => void; projectId: string; columns: Array<{ key: string; label: string }>;
}) {
  const { data } = useAgentPersona(projectId, slug ?? undefined, { enabled: !!slug });
  const update = useUpdateProjectAgent();
  const del = useDeleteProjectAgent();
  const [state, setState] = useState<AgentFormState>({
    name: '', body_md: '', mode: 'per_ticket', canManage: false, defaultCol: '_none', defaultModel: '',
  });
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (data) {
      setState({
        name: data.agent.name,
        body_md: data.body_md,
        mode: data.agent.execution_mode,
        canManage: safeParseJsonArray(data.agent.tool_groups_json).includes('project_manage'),
        defaultCol: safeParseJsonArray(data.agent.default_assignee_columns_json)[0] ?? '_none',
        defaultModel: data.agent.default_model ?? '',
      });
    }
  }, [data?.agent?.id]);

  if (!slug) return null;
  const isPM = slug === 'project-manager';

  const save = () => {
    const groups: ToolGroup[] = state.canManage ? ['project_manage', 'project_action'] : ['project_action'];
    const defaults = state.defaultCol === '_none' ? [] : [state.defaultCol];
    update.mutate({
      projectId, slug, name: state.name, body_md: state.body_md,
      execution_mode: state.mode, tool_groups: groups, default_assignee_columns: defaults,
      default_model: state.defaultModel.trim() || null,
    }, { onSuccess: onClose });
  };

  return (
    <>
      <AgentFormDialog
        open={!!slug}
        onOpenChange={(o) => { if (!o) onClose(); }}
        title={`Edit @${slug}`}
        headerAction={!isPM ? (
          <Button
            variant="ghost" size="sm"
            className="h-6 px-2 text-[11px] text-destructive hover:text-destructive gap-1"
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 className="h-3 w-3" />
            Delete
          </Button>
        ) : undefined}
        footerLeft={`.kortix/agents/${slug}.md`}
        submitLabel="Save"
        submitIcon={update.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
        submitDisabled={update.isPending}
        onSubmit={save}
        onCancel={onClose}
      >
        {!data ? (
          <div className="p-10 text-center text-sm text-muted-foreground/60">
            <Loader2 className="h-4 w-4 animate-spin mx-auto mb-2" />
            Loading…
          </div>
        ) : (
          <AgentFormBody
            columns={columns}
            state={state}
            setState={setState}
          />
        )}
      </AgentFormDialog>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete @${slug}?`}
        description={<>Removes the agent markdown file and deregisters it from the team. Existing tickets aren&apos;t deleted.</>}
        confirmLabel="Delete"
        onConfirm={() => { del.mutate({ projectId, slug }, { onSuccess: onClose }); }}
      />
    </>
  );
}

// ─── Shared dialog chrome ───────────────────────────────────────────────────

function AgentFormDialog({
  open, onOpenChange, title, headerAction, footerLeft, submitLabel, submitIcon,
  submitDisabled, onSubmit, onCancel, children,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  headerAction?: React.ReactNode;
  footerLeft: string;
  submitLabel: string;
  submitIcon: React.ReactNode;
  submitDisabled: boolean;
  onSubmit: () => void;
  onCancel: () => void;
  children: React.ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        // Cap the dialog at 85vh and make the inner body scroll — otherwise
        // a long system prompt pushes header + footer off-screen.
        className="p-0 overflow-hidden gap-0 border-border/60 bg-background max-w-xl sm:max-w-xl max-h-[85vh] flex flex-col"
        hideCloseButton
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <DialogDescription className="sr-only">{title}</DialogDescription>

        <div className="flex items-center px-5 h-11 shrink-0 border-b border-border/40 gap-2">
          <span className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground/55 font-semibold">{title}</span>
          <div className="ml-auto flex items-center gap-2">
            {headerAction}
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-muted-foreground/50 hover:text-foreground" onClick={onCancel}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto">
          {children}
        </div>

        <div className="shrink-0 border-t border-border/40 px-5 py-2.5 flex items-center">
          <span className="text-[11px] text-muted-foreground/40 font-mono truncate">{footerLeft}</span>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
            <Button size="sm" onClick={onSubmit} disabled={submitDisabled} className="gap-1">
              {submitIcon}
              {submitLabel}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Form body — mirrors the ticket composer's 2-column layout ─────────────

function AgentFormBody({
  columns, state, setState, slug, onSlugChange,
}: {
  columns: Array<{ key: string; label: string }>;
  state: AgentFormState;
  setState: React.Dispatch<React.SetStateAction<AgentFormState>>;
  slug?: string;
  onSlugChange?: (v: string) => void;
}) {
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.max(200, el.scrollHeight)}px`;
  }, [state.body_md]);

  const patch = (p: Partial<AgentFormState>) => setState((s) => ({ ...s, ...p }));

  return (
    <div className="grid grid-cols-[1fr_180px] min-h-[320px]">
      <div className="px-5 pt-5 pb-4 flex flex-col min-w-0">
        <input
          value={state.name}
          onChange={(e) => patch({ name: e.target.value })}
          placeholder="Agent name"
          className="w-full text-[20px] font-semibold tracking-tight bg-transparent border-0 outline-none focus:ring-0 placeholder:text-muted-foreground/25 leading-tight"
        />
        {onSlugChange && (
          <div className="mt-1 inline-flex items-center gap-1">
            <span className="text-[11.5px] text-muted-foreground/45 font-mono">@</span>
            <input
              value={slug ?? ''}
              onChange={(e) => onSlugChange(e.target.value)}
              placeholder="slug"
              className="text-[11.5px] bg-transparent font-mono text-muted-foreground/80 border-0 outline-none focus:ring-0 placeholder:text-muted-foreground/25 w-full"
            />
          </div>
        )}
        <textarea
          ref={bodyRef}
          value={state.body_md}
          onChange={(e) => patch({ body_md: e.target.value })}
          placeholder="System prompt — describe responsibilities, flow, and what this agent owns."
          rows={8}
          className="w-full mt-3 text-[13px] leading-[1.7] bg-transparent border-0 outline-none focus:ring-0 resize-none placeholder:text-muted-foreground/25 font-mono overflow-hidden"
        />
      </div>

      <aside className="px-4 pt-5 pb-4 space-y-5">
        <MetaBlock label="Execution">
          <ExecutionPicker value={modeToChoice(state.mode)} onChange={(c) => patch({ mode: choiceToMode(c) })} />
        </MetaBlock>
        <MetaBlock label="Role">
          <RolePicker value={state.canManage ? 'orchestrator' : 'contributor'} onChange={(r) => patch({ canManage: r === 'orchestrator' })} />
        </MetaBlock>
        <MetaBlock label="Default for">
          <ColumnPicker columns={columns} value={state.defaultCol} onChange={(v) => patch({ defaultCol: v })} />
        </MetaBlock>
        <MetaBlock label="Model">
          <ModelPicker value={state.defaultModel} onChange={(v) => patch({ defaultModel: v })} />
          <p className="text-[10.5px] text-muted-foreground/40 mt-1 leading-snug">
            Overrides the session default when this agent runs.
          </p>
        </MetaBlock>
      </aside>
    </div>
  );
}

function MetaBlock({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground/55 font-semibold mb-2">{label}</div>
      {children}
    </div>
  );
}

// ─── Dropdown pickers (match the ticket composer's status picker) ──────────

function ExecutionPicker({ value, onChange }: { value: ExecutionChoice; onChange: (v: ExecutionChoice) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="group w-full inline-flex items-center gap-2 h-8 px-2.5 rounded-lg border border-border/50 hover:border-border bg-card/60 hover:bg-muted/40 text-[12.5px] text-foreground transition-colors cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-primary/30">
          <Zap className="h-3.5 w-3.5 text-muted-foreground/55" />
          <span className="flex-1 text-left truncate font-medium">{EXECUTION_LABELS[value]}</span>
          <ChevronDown className="h-3 w-3 text-muted-foreground/40 group-hover:text-foreground transition-colors" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[260px] z-[10000]">
        <DropdownMenuLabel className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground/55 font-semibold">Execution mode</DropdownMenuLabel>
        {(['per_ticket', 'new_session'] as ExecutionChoice[]).map((choice) => (
          <DropdownMenuItem
            key={choice}
            onClick={() => onChange(choice)}
            className="items-start gap-2 cursor-pointer py-2"
          >
            <div className="mt-0.5 w-4 h-4 flex items-center justify-center">
              {value === choice && <Check className="h-3 w-3 text-primary" />}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[12px] font-medium">{EXECUTION_LABELS[choice]}</div>
              <div className="text-[10.5px] text-muted-foreground/60 leading-snug whitespace-normal">
                {EXECUTION_DESCRIPTIONS[choice]}
              </div>
            </div>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RolePicker({ value, onChange }: { value: 'contributor' | 'orchestrator'; onChange: (v: 'contributor' | 'orchestrator') => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="group w-full inline-flex items-center gap-2 h-8 px-2.5 rounded-lg border border-border/50 hover:border-border bg-card/60 hover:bg-muted/40 text-[12.5px] text-foreground transition-colors cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-primary/30">
          <ShieldCheck className={cn('h-3.5 w-3.5', value === 'orchestrator' ? 'text-primary' : 'text-muted-foreground/55')} />
          <span className="flex-1 text-left truncate font-medium capitalize">{value}</span>
          <ChevronDown className="h-3 w-3 text-muted-foreground/40 group-hover:text-foreground transition-colors" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[260px] z-[10000]">
        <DropdownMenuLabel className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground/55 font-semibold">Role</DropdownMenuLabel>
        <DropdownMenuItem onClick={() => onChange('contributor')} className="items-start gap-2 cursor-pointer py-2">
          <div className="mt-0.5 w-4 h-4 flex items-center justify-center">
            {value === 'contributor' && <Check className="h-3 w-3 text-primary" />}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[12px] font-medium">Contributor</div>
            <div className="text-[10.5px] text-muted-foreground/60 leading-snug whitespace-normal">
              Can work tickets: comment, move status, assign, edit fields.
            </div>
          </div>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onChange('orchestrator')} className="items-start gap-2 cursor-pointer py-2">
          <div className="mt-0.5 w-4 h-4 flex items-center justify-center">
            {value === 'orchestrator' && <Check className="h-3 w-3 text-primary" />}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[12px] font-medium">Orchestrator</div>
            <div className="text-[10.5px] text-muted-foreground/60 leading-snug whitespace-normal">
              Plus: manage team, columns, custom fields, templates, context.
            </div>
          </div>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ModelPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { data: providers } = useOpenCodeProviders();
  const models = useMemo(() => flattenModels(providers), [providers]);
  const byProvider = useMemo(() => {
    const m = new Map<string, { providerName: string; models: FlatModel[] }>();
    for (const mod of models) {
      const g = m.get(mod.providerID);
      if (g) g.models.push(mod);
      else m.set(mod.providerID, { providerName: mod.providerName || mod.providerID, models: [mod] });
    }
    return Array.from(m.entries());
  }, [models]);
  const selected = models.find((m) => `${m.providerID}/${m.modelID}` === value) ?? null;
  const label = selected ? selected.modelName : value ? value.split('/').slice(-1)[0] : 'Session default';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="group w-full inline-flex items-center gap-2 h-8 px-2.5 rounded-lg border border-border/50 hover:border-border bg-card/60 hover:bg-muted/40 text-[12.5px] text-foreground transition-colors cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-primary/30">
          <Cpu className={cn('h-3.5 w-3.5 shrink-0', value ? 'text-primary' : 'text-muted-foreground/55')} />
          <span className={cn('flex-1 text-left truncate', value ? 'font-medium' : 'text-muted-foreground/60')}>{label}</span>
          <ChevronDown className="h-3 w-3 text-muted-foreground/40 group-hover:text-foreground transition-colors" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-[260px] max-h-[340px] overflow-y-auto z-[10000]"
      >
        <DropdownMenuLabel className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground/55 font-semibold">
          Default model
        </DropdownMenuLabel>
        <DropdownMenuItem onClick={() => onChange('')} className="gap-2 cursor-pointer">
          <span className="flex-1 text-muted-foreground/80">Session default</span>
          {!value && <Check className="h-3 w-3 text-primary" />}
        </DropdownMenuItem>
        {byProvider.length === 0 ? (
          <div className="px-2 py-3 text-[11.5px] text-muted-foreground/55">
            No providers connected.
          </div>
        ) : (
          byProvider.map(([providerID, group]) => (
            <div key={providerID}>
              <DropdownMenuLabel className="text-[10px] uppercase tracking-[0.06em] text-muted-foreground/45 font-medium pt-2">
                {group.providerName}
              </DropdownMenuLabel>
              {group.models.map((m) => {
                const key = `${m.providerID}/${m.modelID}`;
                const active = key === value;
                return (
                  <DropdownMenuItem
                    key={key}
                    onClick={() => onChange(key)}
                    className="gap-2 cursor-pointer"
                  >
                    <span className="flex-1 truncate text-[12px]">{m.modelName}</span>
                    {active && <Check className="h-3 w-3 text-primary shrink-0" />}
                  </DropdownMenuItem>
                );
              })}
            </div>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ColumnPicker({ columns, value, onChange }: { columns: Array<{ key: string; label: string }>; value: string; onChange: (v: string) => void }) {
  const label = value === '_none' ? 'None' : (columns.find((c) => c.key === value)?.label ?? value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="group w-full inline-flex items-center gap-2 h-8 px-2.5 rounded-lg border border-border/50 hover:border-border bg-card/60 hover:bg-muted/40 text-[12.5px] text-foreground transition-colors cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-primary/30">
          <Cpu className="h-3.5 w-3.5 text-muted-foreground/55" />
          <span className="flex-1 text-left truncate font-medium">{label}</span>
          <ChevronDown className="h-3 w-3 text-muted-foreground/40 group-hover:text-foreground transition-colors" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[220px] z-[10000]">
        <DropdownMenuLabel className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground/55 font-semibold">Default for column</DropdownMenuLabel>
        <DropdownMenuItem onClick={() => onChange('_none')} className="gap-2 cursor-pointer">
          <span className="flex-1">None</span>
          {value === '_none' && <Check className="h-3 w-3 text-primary" />}
        </DropdownMenuItem>
        {columns.map((c) => (
          <DropdownMenuItem key={c.key} onClick={() => onChange(c.key)} className="gap-2 cursor-pointer">
            <span className="flex-1 truncate">{c.label}</span>
            {value === c.key && <Check className="h-3 w-3 text-primary" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

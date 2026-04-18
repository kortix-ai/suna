'use client';

/**
 * Team tab — single-column roster that matches the Project About design
 * language (max-w-3xl container, uppercase section labels, rounded-xl cards
 * on bg-card with border-border/40, row dividers for list items).
 */

import { useEffect, useState } from 'react';
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
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
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

// ─── Create dialog ───────────────────────────────────────────────────────────

function CreateAgentDialog({ open, onClose, projectId, columns }: {
  open: boolean; onClose: () => void; projectId: string; columns: Array<{ key: string; label: string }>;
}) {
  const create = useCreateProjectAgent();
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [body_md, setBodyMd] = useState(DEFAULT_PROMPT);
  const [mode, setMode] = useState<ExecutionMode>('per_ticket');
  const [canManage, setCanManage] = useState(false);
  const [defaultCol, setDefaultCol] = useState<string>('_none');

  useEffect(() => {
    if (open) {
      setSlug('');
      setName('');
      setBodyMd(DEFAULT_PROMPT);
      setMode('per_ticket');
      setCanManage(false);
      setDefaultCol('_none');
    }
  }, [open]);

  const submit = () => {
    if (!slug.trim() || !name.trim()) return;
    const groups: ToolGroup[] = canManage ? ['project_manage', 'project_action'] : ['project_action'];
    const defaults = defaultCol === '_none' ? [] : [defaultCol];
    create.mutate({
      projectId, slug: slug.trim(), name: name.trim(), body_md,
      execution_mode: mode, tool_groups: groups, default_assignee_columns: defaults,
    }, { onSuccess: onClose });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-xl p-0 overflow-hidden gap-0 border-border/60 bg-background" hideCloseButton>
        <DialogTitle className="sr-only">New agent</DialogTitle>
        <DialogDescription className="sr-only">Create a new team agent</DialogDescription>

        <div className="flex items-center px-5 h-11 border-b border-border/40">
          <span className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground/55 font-semibold">New team agent</span>
          <Button variant="ghost" size="sm" className="ml-auto h-7 w-7 p-0 text-muted-foreground/50" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="px-5 py-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <LabeledInput label="Slug" value={slug} onChange={(v) => setSlug(v.toLowerCase().replace(/[^a-z0-9-_]/g, '-'))} placeholder="e.g. engineer" />
            <LabeledInput label="Display name" value={name} onChange={setName} placeholder="e.g. Engineer" />
          </div>

          <LabeledBlock label="System prompt">
            <textarea
              value={body_md}
              onChange={(e) => setBodyMd(e.target.value)}
              rows={10}
              className="w-full text-[12px] font-mono bg-card border border-border/40 rounded-xl px-3.5 py-3 outline-none focus:border-primary/30 focus:ring-1 focus:ring-primary/20 resize-none leading-[1.7]"
            />
          </LabeledBlock>

          <div className="grid grid-cols-3 gap-3">
            <LabeledBlock label="Execution">
              <Select value={mode} onValueChange={(v) => setMode(v as ExecutionMode)}>
                <SelectTrigger size="sm" className="h-7 text-[12px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="per_ticket">Per-ticket</SelectItem>
                  <SelectItem value="per_assignment">Per-assignment</SelectItem>
                  <SelectItem value="persistent" disabled>Persistent (soon)</SelectItem>
                </SelectContent>
              </Select>
            </LabeledBlock>
            <LabeledBlock label="Role">
              <Select value={canManage ? 'manage' : 'action'} onValueChange={(v) => setCanManage(v === 'manage')}>
                <SelectTrigger size="sm" className="h-7 text-[12px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="action">Contributor</SelectItem>
                  <SelectItem value="manage">Orchestrator</SelectItem>
                </SelectContent>
              </Select>
            </LabeledBlock>
            <LabeledBlock label="Default for column">
              <Select value={defaultCol} onValueChange={setDefaultCol}>
                <SelectTrigger size="sm" className="h-7 text-[12px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="_none">None</SelectItem>
                  {columns.map((c) => <SelectItem key={c.key} value={c.key}>{c.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </LabeledBlock>
          </div>
        </div>

        <div className="border-t border-border/40 px-5 py-2.5 flex items-center">
          <span className="text-[11px] text-muted-foreground/40">Writes .kortix/agents/{slug || 'slug'}.md</span>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
            <Button size="sm" onClick={submit} disabled={!slug.trim() || !name.trim() || create.isPending} className="gap-1">
              {create.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
              Create
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Edit dialog ────────────────────────────────────────────────────────────

function EditAgentDialog({ slug, onClose, projectId, columns }: {
  slug: string | null; onClose: () => void; projectId: string; columns: Array<{ key: string; label: string }>;
}) {
  const { data } = useAgentPersona(projectId, slug ?? undefined, { enabled: !!slug });
  const update = useUpdateProjectAgent();
  const del = useDeleteProjectAgent();
  const [name, setName] = useState('');
  const [body_md, setBodyMd] = useState('');
  const [mode, setMode] = useState<ExecutionMode>('per_ticket');
  const [canManage, setCanManage] = useState(false);
  const [defaultCol, setDefaultCol] = useState<string>('_none');
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (data) {
      setName(data.agent.name);
      setBodyMd(data.body_md);
      setMode(data.agent.execution_mode);
      setCanManage(safeParseJsonArray(data.agent.tool_groups_json).includes('project_manage'));
      const cols = safeParseJsonArray(data.agent.default_assignee_columns_json);
      setDefaultCol(cols[0] ?? '_none');
    }
  }, [data?.agent?.id]);

  if (!slug) return null;
  const isPM = slug === 'project-manager';

  const save = () => {
    const groups: ToolGroup[] = canManage ? ['project_manage', 'project_action'] : ['project_action'];
    const defaults = defaultCol === '_none' ? [] : [defaultCol];
    update.mutate({
      projectId, slug, name, body_md,
      execution_mode: mode, tool_groups: groups, default_assignee_columns: defaults,
    }, { onSuccess: onClose });
  };

  return (
    <Dialog open={!!slug} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-xl p-0 overflow-hidden gap-0 border-border/60 bg-background" hideCloseButton>
        <DialogTitle className="sr-only">Edit agent</DialogTitle>
        <DialogDescription className="sr-only">Edit agent</DialogDescription>

        <div className="flex items-center px-5 h-11 border-b border-border/40">
          <span className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground/55 font-semibold">Edit @{slug}</span>
          {!isPM && (
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto h-6 px-2 text-[11px] text-destructive hover:text-destructive gap-1"
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 className="h-3 w-3" />
              Delete
            </Button>
          )}
          <Button variant="ghost" size="sm" className={isPM ? 'ml-auto h-7 w-7 p-0 text-muted-foreground/50' : 'h-7 w-7 p-0 text-muted-foreground/50 ml-1'} onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        {!data ? (
          <div className="p-10 text-center text-sm text-muted-foreground/60">
            <Loader2 className="h-4 w-4 animate-spin mx-auto mb-2" />
            Loading…
          </div>
        ) : (
          <>
            <div className="px-5 py-4 space-y-3">
              <LabeledInput label="Display name" value={name} onChange={setName} />
              <LabeledBlock label="System prompt">
                <textarea
                  value={body_md}
                  onChange={(e) => setBodyMd(e.target.value)}
                  rows={12}
                  className="w-full text-[12px] font-mono bg-card border border-border/40 rounded-xl px-3.5 py-3 outline-none focus:border-primary/30 focus:ring-1 focus:ring-primary/20 resize-none leading-[1.7]"
                />
              </LabeledBlock>
              <div className="grid grid-cols-3 gap-3">
                <LabeledBlock label="Execution">
                  <Select value={mode} onValueChange={(v) => setMode(v as ExecutionMode)}>
                    <SelectTrigger size="sm" className="h-7 text-[12px]"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="per_ticket">Per-ticket</SelectItem>
                      <SelectItem value="per_assignment">Per-assignment</SelectItem>
                      <SelectItem value="persistent" disabled>Persistent (soon)</SelectItem>
                    </SelectContent>
                  </Select>
                </LabeledBlock>
                <LabeledBlock label="Role">
                  <Select value={canManage ? 'manage' : 'action'} onValueChange={(v) => setCanManage(v === 'manage')}>
                    <SelectTrigger size="sm" className="h-7 text-[12px]"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="action">Contributor</SelectItem>
                      <SelectItem value="manage">Orchestrator</SelectItem>
                    </SelectContent>
                  </Select>
                </LabeledBlock>
                <LabeledBlock label="Default column">
                  <Select value={defaultCol} onValueChange={setDefaultCol}>
                    <SelectTrigger size="sm" className="h-7 text-[12px]"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="_none">None</SelectItem>
                      {columns.map((c) => <SelectItem key={c.key} value={c.key}>{c.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </LabeledBlock>
              </div>
            </div>

            <div className="border-t border-border/40 px-5 py-2.5 flex items-center">
              <span className="text-[11px] text-muted-foreground/40 font-mono truncate">.kortix/agents/{slug}.md</span>
              <div className="ml-auto flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
                <Button size="sm" onClick={save} disabled={update.isPending} className="gap-1">
                  {update.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                  Save
                </Button>
              </div>
            </div>
          </>
        )}
      </DialogContent>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete @${slug}?`}
        description={<>Removes the agent markdown file and deregisters it from the team. Existing tickets aren&apos;t deleted.</>}
        confirmLabel="Delete"
        onConfirm={() => { del.mutate({ projectId, slug }, { onSuccess: onClose }); }}
      />
    </Dialog>
  );
}

function LabeledInput({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <LabeledBlock label={label}>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-7 w-full text-[12px] bg-transparent border border-border/40 rounded px-2 outline-none focus:ring-2 focus:ring-primary/20"
      />
    </LabeledBlock>
  );
}

function LabeledBlock({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground/55 font-semibold mb-1.5">{label}</div>
      {children}
    </div>
  );
}

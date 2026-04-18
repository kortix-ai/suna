'use client';

/**
 * Team tab — list + manage project agents.
 *
 * Shows one card per agent + a "you (user)" marker at the top. Clicking an
 * agent opens an edit drawer. "+ New agent" opens a create dialog.
 */

import { useEffect, useMemo, useState } from 'react';
import { Plus, UserCircle2, Bot, Trash2, Save } from 'lucide-react';
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
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="container mx-auto max-w-5xl px-4 py-6">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 className="text-[14px] font-semibold tracking-tight">Team</h2>
            <p className="text-[12px] text-muted-foreground/60 mt-0.5">Agents that work on this project, plus you.</p>
          </div>
          <Button size="sm" onClick={() => setCreateOpen(true)} className="h-7 px-3 text-[12px]">
            <Plus className="h-3.5 w-3.5 mr-1" />
            New agent
          </Button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <UserCard handle={userHandle} />
          {agents.map((a) => (
            <AgentCard
              key={a.id}
              agent={a}
              onClick={() => setEditSlug(a.slug)}
            />
          ))}
        </div>
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

function UserCard({ handle }: { handle: string }) {
  return (
    <div className="rounded-xl border border-border/50 bg-card p-4 flex items-start gap-3">
      <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
        <UserCircle2 className="h-4 w-4 text-primary" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-semibold">@{handle}</span>
          <span className="text-[11px] text-muted-foreground/50">real human</span>
        </div>
        <p className="text-[12px] text-muted-foreground/60 mt-1">Agents tag @{handle} when they need a decision you haven't automated away.</p>
      </div>
    </div>
  );
}

function AgentCard({ agent, onClick }: { agent: ProjectAgent; onClick: () => void }) {
  const groups = safeParseJsonArray(agent.tool_groups_json);
  const cols = safeParseJsonArray(agent.default_assignee_columns_json);
  const role = groups.includes('project_manage') ? 'Orchestrator' : 'Contributor';
  return (
    <button
      onClick={onClick}
      className="text-left rounded-xl border border-border/50 bg-card p-4 hover:border-border hover:bg-muted/20 transition-colors cursor-pointer"
    >
      <div className="flex items-start gap-3">
        <div className="w-8 h-8 rounded-full bg-muted/40 flex items-center justify-center shrink-0">
          <Bot className="h-4 w-4 text-muted-foreground/60" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-semibold">{agent.name}</span>
            <span className="text-[11px] font-mono text-muted-foreground/50">@{agent.slug}</span>
          </div>
          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
            <span className="inline-flex items-center h-4 px-1.5 rounded text-[10px] font-medium bg-muted/50 text-muted-foreground/80">{role}</span>
            <span className="inline-flex items-center h-4 px-1.5 rounded text-[10px] font-mono bg-muted/50 text-muted-foreground/80">{agent.execution_mode}</span>
            {cols.map((c) => (
              <span key={c} className="inline-flex items-center h-4 px-1.5 rounded text-[10px] font-medium bg-primary/10 text-primary">
                default:{c}
              </span>
            ))}
          </div>
        </div>
      </div>
    </button>
  );
}

// ── Create dialog ────────────────────────────────────────────────────────────

function CreateAgentDialog({ open, onClose, projectId, columns }: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  columns: Array<{ key: string; label: string }>;
}) {
  const create = useCreateProjectAgent();
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [body_md, setBodyMd] = useState(DEFAULT_PROMPT);
  const [mode, setMode] = useState<ExecutionMode>('per_ticket');
  const [canManage, setCanManage] = useState(false);
  const [defaultCols, setDefaultCols] = useState<string[]>([]);

  useEffect(() => {
    if (open) {
      setSlug('');
      setName('');
      setBodyMd(DEFAULT_PROMPT);
      setMode('per_ticket');
      setCanManage(false);
      setDefaultCols([]);
    }
  }, [open]);

  const submit = () => {
    if (!slug.trim() || !name.trim()) return;
    const groups: ToolGroup[] = canManage ? ['project_manage', 'project_action'] : ['project_action'];
    create.mutate({
      projectId, slug: slug.trim(), name: name.trim(), body_md,
      execution_mode: mode, tool_groups: groups, default_assignee_columns: defaultCols,
    }, { onSuccess: onClose });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl p-0 overflow-hidden">
        <DialogTitle className="sr-only">Create agent</DialogTitle>
        <DialogDescription className="sr-only">Create a new team agent</DialogDescription>
        <div className="px-5 py-4">
          <h3 className="text-[13px] font-semibold mb-4">New team agent</h3>
          <div className="grid grid-cols-2 gap-3">
            <LabeledInput label="Slug" value={slug} onChange={setSlug} placeholder="e.g. engineer" />
            <LabeledInput label="Name" value={name} onChange={setName} placeholder="e.g. Engineer" />
          </div>

          <div className="mt-3">
            <label className="text-[11px] uppercase tracking-wider text-muted-foreground/60 mb-1 block">System prompt</label>
            <textarea
              value={body_md}
              onChange={(e) => setBodyMd(e.target.value)}
              rows={10}
              className="w-full text-[12px] font-mono bg-transparent border border-border/50 rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-primary/20 resize-none"
            />
          </div>

          <div className="grid grid-cols-3 gap-3 mt-3">
            <div>
              <label className="text-[11px] uppercase tracking-wider text-muted-foreground/60 mb-1 block">Execution</label>
              <Select value={mode} onValueChange={(v) => setMode(v as ExecutionMode)}>
                <SelectTrigger size="sm" className="h-7 text-[12px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="per_ticket">Per-ticket (default)</SelectItem>
                  <SelectItem value="per_assignment">Per-assignment</SelectItem>
                  <SelectItem value="persistent" disabled>Persistent (soon)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-[11px] uppercase tracking-wider text-muted-foreground/60 mb-1 block">Role</label>
              <Select value={canManage ? 'manage' : 'action'} onValueChange={(v) => setCanManage(v === 'manage')}>
                <SelectTrigger size="sm" className="h-7 text-[12px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="action">Contributor (project_action)</SelectItem>
                  <SelectItem value="manage">Orchestrator (+ project_manage)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-[11px] uppercase tracking-wider text-muted-foreground/60 mb-1 block">Default for column</label>
              <Select
                value={defaultCols[0] ?? '_none'}
                onValueChange={(v) => setDefaultCols(v === '_none' ? [] : [v])}
              >
                <SelectTrigger size="sm" className="h-7 text-[12px]"><SelectValue placeholder="None" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="_none">None</SelectItem>
                  {columns.map((c) => <SelectItem key={c.key} value={c.key}>{c.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 mt-5">
            <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
            <Button size="sm" onClick={submit} disabled={!slug.trim() || !name.trim() || create.isPending}>
              Create agent
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Edit dialog ──────────────────────────────────────────────────────────────

function EditAgentDialog({ slug, onClose, projectId, columns }: {
  slug: string | null;
  onClose: () => void;
  projectId: string;
  columns: Array<{ key: string; label: string }>;
}) {
  const { data } = useAgentPersona(projectId, slug ?? undefined, { enabled: !!slug });
  const update = useUpdateProjectAgent();
  const del = useDeleteProjectAgent();
  const [name, setName] = useState('');
  const [body_md, setBodyMd] = useState('');
  const [mode, setMode] = useState<ExecutionMode>('per_ticket');
  const [canManage, setCanManage] = useState(false);
  const [defaultCols, setDefaultCols] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (data) {
      setName(data.agent.name);
      setBodyMd(data.body_md);
      setMode(data.agent.execution_mode);
      setCanManage(safeParseJsonArray(data.agent.tool_groups_json).includes('project_manage'));
      setDefaultCols(safeParseJsonArray(data.agent.default_assignee_columns_json));
    }
  }, [data?.agent?.id]);

  if (!slug) return null;
  const isPM = slug === 'project-manager';

  const save = () => {
    const groups: ToolGroup[] = canManage ? ['project_manage', 'project_action'] : ['project_action'];
    update.mutate({
      projectId, slug, name, body_md,
      execution_mode: mode, tool_groups: groups, default_assignee_columns: defaultCols,
    }, { onSuccess: onClose });
  };

  return (
    <Dialog open={!!slug} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl p-0 overflow-hidden">
        <DialogTitle className="sr-only">Edit agent</DialogTitle>
        <DialogDescription className="sr-only">Edit agent</DialogDescription>
        {!data ? (
          <div className="p-6 text-center text-sm text-muted-foreground">Loading…</div>
        ) : (
          <div className="px-5 py-4">
            <div className="flex items-center gap-2 mb-4">
              <h3 className="text-[13px] font-semibold">Edit @{slug}</h3>
              {!isPM && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto h-7 text-destructive hover:text-destructive"
                  onClick={() => setConfirmDelete(true)}
                >
                  <Trash2 className="h-3.5 w-3.5 mr-1" />
                  Delete
                </Button>
              )}
            </div>

            <LabeledInput label="Name" value={name} onChange={setName} />

            <div className="mt-3">
              <label className="text-[11px] uppercase tracking-wider text-muted-foreground/60 mb-1 block">System prompt</label>
              <textarea
                value={body_md}
                onChange={(e) => setBodyMd(e.target.value)}
                rows={12}
                className="w-full text-[12px] font-mono bg-transparent border border-border/50 rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-primary/20 resize-none"
              />
            </div>

            <div className="grid grid-cols-3 gap-3 mt-3">
              <div>
                <label className="text-[11px] uppercase tracking-wider text-muted-foreground/60 mb-1 block">Execution</label>
                <Select value={mode} onValueChange={(v) => setMode(v as ExecutionMode)}>
                  <SelectTrigger size="sm" className="h-7 text-[12px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="per_ticket">Per-ticket</SelectItem>
                    <SelectItem value="per_assignment">Per-assignment</SelectItem>
                    <SelectItem value="persistent" disabled>Persistent (soon)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-[11px] uppercase tracking-wider text-muted-foreground/60 mb-1 block">Role</label>
                <Select value={canManage ? 'manage' : 'action'} onValueChange={(v) => setCanManage(v === 'manage')}>
                  <SelectTrigger size="sm" className="h-7 text-[12px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="action">Contributor</SelectItem>
                    <SelectItem value="manage">Orchestrator</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-[11px] uppercase tracking-wider text-muted-foreground/60 mb-1 block">Default for column</label>
                <Select
                  value={defaultCols[0] ?? '_none'}
                  onValueChange={(v) => setDefaultCols(v === '_none' ? [] : [v])}
                >
                  <SelectTrigger size="sm" className="h-7 text-[12px]"><SelectValue placeholder="None" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="_none">None</SelectItem>
                    {columns.map((c) => <SelectItem key={c.key} value={c.key}>{c.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 mt-5">
              <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
              <Button size="sm" onClick={save} disabled={update.isPending}>
                <Save className="h-3.5 w-3.5 mr-1.5" />
                Save
              </Button>
            </div>
          </div>
        )}
      </DialogContent>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete @${slug}?`}
        description={<>Removes the agent markdown file and deregisters it from the team. Existing tickets aren't deleted.</>}
        confirmLabel="Delete"
        onConfirm={() => { del.mutate({ projectId, slug }, { onSuccess: onClose }); }}
      />
    </Dialog>
  );
}

function LabeledInput({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div>
      <label className="text-[11px] uppercase tracking-wider text-muted-foreground/60 mb-1 block">{label}</label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-7 w-full text-[12px] bg-transparent border border-border/50 rounded px-2 outline-none focus:ring-2 focus:ring-primary/20"
      />
    </div>
  );
}

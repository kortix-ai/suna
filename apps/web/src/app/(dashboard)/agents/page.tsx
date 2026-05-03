'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bot,
  FileText,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Search,
  Trash2,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { deleteFile, listFiles, readFile, uploadFile } from '@/features/files/api/opencode-files';
import { getClient } from '@/lib/opencode-sdk';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import {
  opencodeKeys,
  useOpenCodeAgents,
  type Agent,
} from '@/hooks/opencode/use-opencode-sessions';

const AGENT_DIR = '/workspace/.opencode/agent';

type Mode = 'primary' | 'subagent' | 'all';

interface EditableAgent {
  name: string;
  description: string;
  mode: Mode;
  model: string;
  prompt: string;
  path: string;
  exists: boolean;
}

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function pathFor(name: string) {
  return `${AGENT_DIR}/${slugify(name)}.md`;
}

function yamlValue(value: string) {
  return JSON.stringify(value);
}

function parseModel(value?: Agent['model']) {
  if (!value) return '';
  return `${value.providerID}/${value.modelID}`;
}

function splitModel(value: string) {
  const [providerID, ...rest] = value.trim().split('/');
  const modelID = rest.join('/');
  if (!providerID || !modelID) return null;
  return { providerID, modelID };
}

function parseFrontmatter(raw: string) {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { data: {} as Record<string, string>, body: raw };

  const data = Object.fromEntries(
    match[1]
      .split('\n')
      .map((line) => line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/))
      .filter((match): match is RegExpMatchArray => Boolean(match))
      .map((match) => {
        const raw = match[2].trim();
        try {
          return [match[1], JSON.parse(raw)] as const;
        } catch {
          return [match[1], raw.replace(/^['"]|['"]$/g, '')] as const;
        }
      }),
  );

  return { data, body: raw.slice(match[0].length) };
}

function renderAgent(agent: EditableAgent) {
  const lines = [
    '---',
    `name: ${agent.name}`,
    `description: ${yamlValue(agent.description)}`,
    `mode: ${agent.mode}`,
  ];
  if (agent.model.trim()) lines.push(`model: ${yamlValue(agent.model.trim())}`);
  lines.push('---', '', agent.prompt.trim(), '');
  return lines.join('\n');
}

async function listAgentFiles() {
  const dirs = [AGENT_DIR, '/workspace/.opencode/agents'];
  const lists = await Promise.all(
    dirs.map((dir) => listFiles(dir).catch(() => [])),
  );
  return lists
    .flat()
    .filter((file) => file.type === 'file' && file.path.endsWith('.md'))
    .map((file) => file.path)
    .sort((a, b) => a.localeCompare(b));
}

async function readAgentFile(path: string) {
  const file = await readFile(path);
  if (file.encoding === 'base64') throw new Error('Agent file is binary');
  return file.content;
}

async function writeAgentFile(path: string, content: string, exists: boolean) {
  if (exists) await deleteFile(path);
  const parts = path.split('/');
  const name = parts.pop() || 'agent.md';
  const file = new File([content], name, { type: 'text/markdown;charset=utf-8' });
  const result = await uploadFile(file, parts.join('/'));
  if (result[0]?.path !== path) {
    throw new Error(`Agent was written to ${result[0]?.path || 'unknown path'} instead of ${path}`);
  }
}

async function reloadAgents() {
  try {
    await getClient().instance.dispose();
  } catch {
    // Older/runtime-unavailable servers still pick up file changes on restart.
  }
}

function agentFromSdk(agent: Agent, paths: string[]): EditableAgent {
  const path = paths.find((item) => item.endsWith(`/${agent.name}.md`)) || pathFor(agent.name);
  return {
    name: agent.name,
    description: agent.description || '',
    mode: agent.mode,
    model: parseModel(agent.model),
    prompt: agent.prompt || '',
    path,
    exists: paths.includes(path),
  };
}

function agentFromFile(path: string, raw: string, fallback?: Agent): EditableAgent {
  const parsed = parseFrontmatter(raw);
  const name = path.split('/').pop()?.replace(/\.md$/, '') || fallback?.name || '';
  return {
    name,
    description: String(parsed.data.description || fallback?.description || ''),
    mode: (parsed.data.mode === 'subagent' || parsed.data.mode === 'all' ? parsed.data.mode : fallback?.mode || 'primary') as Mode,
    model: String(parsed.data.model || parseModel(fallback?.model) || ''),
    prompt: parsed.body.trim() || fallback?.prompt || '',
    path,
    exists: true,
  };
}

export default function AgentsPage() {
  const query = useQueryClient();
  const agents = useOpenCodeAgents({ directory: '/workspace' });
  const files = useQuery({
    queryKey: [...opencodeKeys.agents(), 'files'],
    queryFn: listAgentFiles,
    staleTime: 5_000,
  });
  const [selected, setSelected] = useState('');
  const [draft, setDraft] = useState<EditableAgent | null>(null);
  const [filter, setFilter] = useState('');

  const items = useMemo(() => {
    const paths = files.data ?? [];
    const byName = new Map<string, EditableAgent>();
    for (const agent of agents.data ?? []) byName.set(agent.name, agentFromSdk(agent, paths));
    for (const path of paths) {
      const name = path.split('/').pop()?.replace(/\.md$/, '') || path;
      if (!byName.has(name)) {
        byName.set(name, {
          name,
          description: '',
          mode: 'primary',
          model: '',
          prompt: '',
          path,
          exists: true,
        });
      }
    }
    return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [agents.data, files.data]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) => `${item.name} ${item.description} ${item.path}`.toLowerCase().includes(q));
  }, [filter, items]);

  const selectedItem = useMemo(
    () => items.find((item) => item.name === selected) ?? null,
    [items, selected],
  );

  useEffect(() => {
    if (!selected && items[0]) setSelected(items[0].name);
  }, [items, selected]);

  const load = useQuery({
    queryKey: [...opencodeKeys.agents(), 'file', selectedItem?.path],
    enabled: Boolean(selectedItem),
    queryFn: async () => {
      if (!selectedItem) throw new Error('No agent selected');
      if (!selectedItem.exists) return selectedItem;
      return agentFromFile(
        selectedItem.path,
        await readAgentFile(selectedItem.path),
        agents.data?.find((agent) => agent.name === selectedItem.name),
      );
    },
  });

  useEffect(() => {
    if (load.data) setDraft(load.data);
  }, [load.data]);

  const refresh = async () => {
    await Promise.all([
      query.invalidateQueries({ queryKey: opencodeKeys.agents() }),
      query.invalidateQueries({ queryKey: [...opencodeKeys.agents(), 'files'] }),
    ]);
  };

  const save = useMutation({
    mutationFn: async (agent: EditableAgent) => {
      const name = slugify(agent.name);
      if (!name) throw new Error('Agent name is required');
      if (agent.model.trim() && !splitModel(agent.model)) {
        throw new Error('Model must use provider/model format');
      }
      const path = agent.exists ? agent.path : pathFor(name);
      const next = pathFor(name);
      if (agent.path !== next && items.some((item) => item.path === next)) {
        throw new Error(`Agent already exists at ${next}`);
      }
      if (agent.exists && agent.path !== next) {
        await deleteFile(agent.path);
        await writeAgentFile(next, renderAgent({ ...agent, name, path: next }), false);
      } else {
        await writeAgentFile(path, renderAgent({ ...agent, name, path }), agent.exists);
      }
      await reloadAgents();
      return name;
    },
    onSuccess: async (name) => {
      toast.success('Agent saved');
      setSelected(name);
      await refresh();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : 'Failed to save agent'),
  });

  const remove = useMutation({
    mutationFn: async (agent: EditableAgent) => {
      if (!agent.exists) return;
      await deleteFile(agent.path);
      await reloadAgents();
    },
    onSuccess: async () => {
      toast.success('Agent deleted');
      setSelected('');
      setDraft(null);
      await refresh();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : 'Failed to delete agent'),
  });

  const create = () => {
    const agent: EditableAgent = {
      name: 'new-agent',
      description: 'Describe what this agent is responsible for.',
      mode: 'primary',
      model: '',
      prompt: 'You are a focused OpenCode agent. Describe the role, constraints, and workflow here.',
      path: pathFor('new-agent'),
      exists: false,
    };
    setSelected('new-agent');
    setDraft(agent);
  };

  const loading = agents.isLoading || files.isLoading;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="p-4 pb-0 md:p-6 md:pb-0">
        <PageHeader icon={Bot}>Agents</PageHeader>
        <p className="mx-auto mt-3 max-w-2xl text-center text-sm text-muted-foreground">
          Create, edit, and delete OpenCode agents stored in /workspace/.opencode/agent.
        </p>
      </div>

      <div className="mt-6 grid min-h-0 flex-1 grid-cols-1 border-t border-border/50 lg:grid-cols-[320px_1fr]">
        <aside className="flex min-h-0 flex-col border-b border-border/50 lg:border-b-0 lg:border-r">
          <div className="space-y-3 p-4">
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  placeholder="Search agents"
                  className="h-10 rounded-xl pl-9"
                />
              </div>
              <Button size="icon" variant="outline" onClick={refresh} disabled={loading}>
                <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
              </Button>
            </div>
            <Button className="w-full justify-start rounded-xl" onClick={create}>
              <Plus className="h-4 w-4" />
              New agent
            </Button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
            {loading ? (
              <div className="space-y-2 p-2">
                {Array.from({ length: 6 }).map((_, index) => <Skeleton key={index} className="h-16 rounded-xl" />)}
              </div>
            ) : visible.length ? (
              visible.map((item) => (
                <button
                  key={`${item.name}:${item.path}`}
                  onClick={() => setSelected(item.name)}
                  className={cn(
                    'mb-1 w-full rounded-xl px-3 py-3 text-left transition-colors',
                    selected === item.name
                      ? 'bg-foreground text-background'
                      : 'hover:bg-muted text-foreground',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <Bot className="h-4 w-4 shrink-0 opacity-70" />
                    <span className="truncate text-sm font-medium">{item.name}</span>
                    {!item.exists && <Badge variant="secondary" className="ml-auto text-[10px]">Built-in</Badge>}
                  </div>
                  <p className={cn('mt-1 line-clamp-2 text-xs', selected === item.name ? 'text-background/70' : 'text-muted-foreground')}>
                    {item.description || item.path}
                  </p>
                </button>
              ))
            ) : (
              <div className="px-4 py-10 text-center text-sm text-muted-foreground">
                No agents found.
              </div>
            )}
          </div>
        </aside>

        <main className="min-h-0 overflow-y-auto p-4 md:p-6">
          {!draft || load.isLoading ? (
            <div className="space-y-4">
              <Skeleton className="h-10 w-48 rounded-xl" />
              <Skeleton className="h-24 rounded-2xl" />
              <Skeleton className="h-[420px] rounded-2xl" />
            </div>
          ) : (
            <div className="mx-auto flex max-w-5xl flex-col gap-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <FileText className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm font-medium">{draft.exists ? draft.path : pathFor(draft.name)}</span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Saving rewrites the markdown file and reloads OpenCode agents.
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    className="rounded-xl"
                    onClick={() => remove.mutate(draft)}
                    disabled={!draft.exists || remove.isPending || save.isPending}
                  >
                    {remove.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                    Delete
                  </Button>
                  <Button
                    className="rounded-xl"
                    onClick={() => save.mutate(draft)}
                    disabled={save.isPending || remove.isPending}
                  >
                    {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                    Save
                  </Button>
                </div>
              </div>

              <section className="grid gap-4 rounded-2xl border bg-card/40 p-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="agent-name">Name</Label>
                  <Input
                    id="agent-name"
                    value={draft.name}
                    onChange={(event) => setDraft({ ...draft, name: slugify(event.target.value) })}
                    placeholder="engineer"
                    className="rounded-xl"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="agent-mode">Mode</Label>
                  <select
                    id="agent-mode"
                    value={draft.mode}
                    onChange={(event) => setDraft({ ...draft, mode: event.target.value as Mode })}
                    className="h-11 w-full rounded-xl border bg-card px-3 text-sm font-medium outline-none focus:ring-2 focus:ring-primary/50"
                  >
                    <option value="primary">primary</option>
                    <option value="subagent">subagent</option>
                    <option value="all">all</option>
                  </select>
                </div>
                <div className="space-y-2 md:col-span-2">
                  <Label htmlFor="agent-description">Description</Label>
                  <Input
                    id="agent-description"
                    value={draft.description}
                    onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                    placeholder="Short description shown in the agent picker"
                    className="rounded-xl"
                  />
                </div>
                <div className="space-y-2 md:col-span-2">
                  <Label htmlFor="agent-model">Model override</Label>
                  <Input
                    id="agent-model"
                    value={draft.model}
                    onChange={(event) => setDraft({ ...draft, model: event.target.value })}
                    placeholder="provider/model, optional"
                    className="rounded-xl"
                  />
                </div>
              </section>

              <section className="min-h-[520px] rounded-2xl border bg-card/40 p-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <Label htmlFor="agent-prompt">System Prompt</Label>
                  <Badge variant="outline" className="text-[10px]">Markdown</Badge>
                </div>
                <Textarea
                  id="agent-prompt"
                  value={draft.prompt}
                  onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
                  className="min-h-[460px] resize-y rounded-xl font-mono text-sm leading-relaxed"
                  placeholder="Write the agent's system prompt..."
                />
              </section>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

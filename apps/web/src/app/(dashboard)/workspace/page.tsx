'use client';

import { useCallback, useMemo, useState } from 'react';
import {
  Blocks,
  Bot,
  Check,
  ChevronDown,
  Copy,
  FileText,
  FolderOpen,
  Link,
  Loader2,
  Plug,
  Plus,
  Search,
  Settings,
  Sparkles,
  Terminal,
  Wrench,
  X,
} from 'lucide-react';
import { AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { featureFlags } from '@/lib/feature-flags';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FilterBar, FilterBarItem } from '@/components/ui/tabs';
import { PageSearchBar } from '@/components/ui/page-search-bar';
import { Skeleton } from '@/components/ui/skeleton';
import { WorkspaceItemCard } from '@/components/ui/workspace-item-card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { OpenCodeSettingsDialog, type OpenCodeSettingsTab } from '@/components/session/opencode-settings-dialog';
import {
  useCreateOpenCodeSession,
  useOpenCodeAgents,
  useOpenCodeCommands,
  useOpenCodeToolIds,
  useOpenCodeMcpStatus,
  type Agent,
  type Command,
  type McpStatus,
} from '@/hooks/opencode/use-opencode-sessions';
import { useKortixProjects, type KortixProject } from '@/hooks/kortix/use-kortix-projects';
import { useKortixConnectors, type KortixConnector } from '@/hooks/kortix/use-kortix-connectors';

// Re-export as Project for backward compat in this file
type Project = KortixProject;
import { useSkills } from '@/features/skills/hooks';
import { getSkillSource, type Skill } from '@/features/skills/types';
import { openTabAndNavigate } from '@/stores/tab-store';
import { useServerStore } from '@/stores/server-store';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ItemKind = 'project' | 'agent' | 'skill' | 'command' | 'tool' | 'mcp' | 'connector';
type ItemScope = 'project' | 'global' | 'external' | 'built-in';
type KindFilter = 'all' | ItemKind;
type ScopeFilter = 'all' | ItemScope;
type WorkspaceComposerKind = 'agent' | 'skill' | 'command' | 'project';

interface WorkspaceItem {
  id: string;
  name: string;
  description?: string;
  kind: ItemKind;
  scope: ItemScope;
  meta?: string;
  raw?: Agent | Skill | Command | Project | KortixConnector | { toolId: string; server?: string } | { serverName: string; status: McpStatus };
}

const COMPOSER_PRESETS: Record<WorkspaceComposerKind, { title: string; prompt: string }> = {
  agent:   { title: 'New agent',   prompt: "HEY let's build a new agent. Ask what job it should own, then scaffold it in the right workspace location and wire up any supporting skills." },
  skill:   { title: 'New skill',   prompt: "HEY let's build a new skill. Ask what should trigger it, then create the SKILL.md and any supporting files in the right workspace location." },
  command: { title: 'New command', prompt: "HEY let's build a new slash command. Ask what the command should do, then add it in the right workspace location and connect it to the correct agent." },
  project: { title: 'New project', prompt: "HEY let's set up a new project. Ask for the name and purpose, then create it in the right workspace location with a clean starting structure." },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function commandScope(source?: string): ItemScope {
  if (!source || source === 'command') return 'project';
  return 'external';
}

function mcpToolName(id: string): string {
  return id.startsWith('mcp_') ? id.split('_').slice(2).join('_') : id;
}
function mcpServerName(id: string): string | undefined {
  return id.startsWith('mcp_') ? id.split('_')[1] : undefined;
}

// ---------------------------------------------------------------------------
// Kind / scope config
// ---------------------------------------------------------------------------

const KIND_CONFIG: Record<ItemKind, { icon: typeof Bot; label: string }> = {
  project:   { icon: FolderOpen, label: 'Project' },
  agent:     { icon: Bot,        label: 'Agent' },
  skill:     { icon: Sparkles,   label: 'Skill' },
  command:   { icon: Terminal,    label: 'Command' },
  tool:      { icon: Wrench,     label: 'Tool' },
  mcp:       { icon: Plug,       label: 'MCP' },
  connector: { icon: Link,       label: 'Connector' },
};

const SCOPE_LABEL: Record<ItemScope, string> = {
  project:    'Project',
  global:     'Global',
  external:   'External',
  'built-in': 'Built-in',
};

// ---------------------------------------------------------------------------
// Detail sheet — proper radix Sheet sliding from right
// ---------------------------------------------------------------------------

function DetailSheet({
  item,
  open,
  onOpenChange,
}: {
  item: WorkspaceItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);

  const copy = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 1500);
  };

  const kindCfg = item ? KIND_CONFIG[item.kind] : KIND_CONFIG.agent;

  const rows: Array<{ label: string; value: string; mono?: boolean }> = [];
  let content: string | null = null;

  if (item?.kind === 'agent' && item.raw) {
    const a = item.raw as Agent;
    if (a.model) rows.push({ label: 'Model', value: `${a.model.providerID}/${a.model.modelID}`, mono: true });
    rows.push({ label: 'Mode', value: a.mode });
    if (a.variant) rows.push({ label: 'Variant', value: a.variant });
    if (a.temperature !== undefined) rows.push({ label: 'Temperature', value: String(a.temperature) });
    if (a.steps !== undefined) rows.push({ label: 'Max Steps', value: String(a.steps) });
    if (a.prompt) content = a.prompt;
  }
  if (item?.kind === 'skill' && item.raw) {
    const s = item.raw as Skill;
    rows.push({ label: 'Location', value: s.location, mono: true });
    if (s.content) content = s.content;
  }
  if (item?.kind === 'command' && item.raw) {
    const c = item.raw as Command;
    if (c.source) rows.push({ label: 'Source', value: c.source });
    if (c.agent) rows.push({ label: 'Agent', value: c.agent });
    if (c.model) rows.push({ label: 'Model', value: c.model, mono: true });
    if (c.hints?.length) rows.push({ label: 'Hints', value: c.hints.join(', ') });
    if (c.template) content = c.template;
  }
  if (item?.kind === 'project' && item.raw) {
    const p = item.raw as Project;
    rows.push({ label: 'ID', value: p.id, mono: true });
    if (p.path) rows.push({ label: 'Path', value: p.path, mono: true });
    if (p.description) rows.push({ label: 'Description', value: p.description });
  }
  if (item?.kind === 'tool' && item.raw) {
    const t = item.raw as { toolId: string; server?: string };
    rows.push({ label: 'Tool ID', value: t.toolId, mono: true });
    if (t.server) rows.push({ label: 'MCP Server', value: t.server });
  }
  if (item?.kind === 'mcp' && item.raw) {
    const m = item.raw as { serverName: string; status: McpStatus };
    rows.push({ label: 'Server', value: m.serverName });
    rows.push({ label: 'Status', value: m.status.status });
    if (m.status.status === 'failed' && 'error' in m.status) {
      rows.push({ label: 'Error', value: (m.status as { error: string }).error });
    }
  }
  if (item?.kind === 'connector' && item.raw) {
    const c = item.raw as unknown as KortixConnector;
    if (c.source) rows.push({ label: 'Source', value: c.source });
    if (c.pipedream_slug) rows.push({ label: 'Pipedream', value: c.pipedream_slug, mono: true });
    if (c.env_keys?.length) rows.push({ label: 'Env', value: c.env_keys.join(', '), mono: true });
    if (c.auto_generated) rows.push({ label: 'Auto', value: 'Created by Pipedream OAuth' });
    rows.push({ label: 'Updated', value: new Date(c.updated_at).toLocaleString() });
    if (c.notes) content = c.notes;
  }

  const contentLabel =
    item?.kind === 'skill'     ? 'SKILL.md' :
    item?.kind === 'command'   ? 'template' :
    item?.kind === 'agent'     ? 'system prompt' :
    item?.kind === 'connector' ? 'notes' :
    'content';

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-lg p-0 flex flex-col gap-0 [&>button:last-child]:hidden"
      >
        {item && (
          <>
            {/* Header */}
            <SheetHeader className="px-6 pt-6 pb-4 border-b border-border/50 gap-0 space-y-0">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <SheetTitle className={cn('text-sm break-all', item.kind === 'command' && 'font-mono')}>
                    {item.name}
                  </SheetTitle>
                  <SheetDescription className="sr-only">
                    {kindCfg.label} details for {item.name}
                  </SheetDescription>
                  <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                    <Badge variant="secondary" className="text-[10px]">{kindCfg.label}</Badge>
                    <Badge variant="secondary" className="text-[10px]">{SCOPE_LABEL[item.scope]}</Badge>
                    {item.meta && <span className="text-[10px] text-muted-foreground/50">{item.meta}</span>}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2.5 text-xs text-muted-foreground hover:text-foreground shrink-0 gap-1"
                  onClick={() => copy(item.name, 'name')}
                >
                  {copied === 'name'
                    ? <><Check className="h-3 w-3" />Copied</>
                    : <><Copy className="h-3 w-3" />Copy</>
                  }
                </Button>
              </div>
              {item.description && (
                <p className="text-xs text-muted-foreground leading-relaxed mt-3">{item.description}</p>
              )}

            </SheetHeader>

            {/* Scrollable body */}
            <div className="flex-1 overflow-y-auto">
              {/* Properties */}
              {rows.length > 0 && (
                <div className="px-6 py-5">
                  <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60 mb-3">Properties</p>
                  <div className="space-y-3">
                    {rows.map((row) => (
                      <div key={row.label} className="grid grid-cols-[100px_1fr] gap-2">
                        <span className="text-xs text-muted-foreground">{row.label}</span>
                        <span className={cn('text-xs text-foreground break-all', row.mono && 'font-mono')}>
                          {row.value}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Content preview */}
              {content && (
                <>
                  <div className="flex items-center justify-between px-6 py-3 border-y border-border/50 bg-muted/30">
                    <div className="flex items-center gap-2">
                      <FileText className="h-3 w-3 text-muted-foreground/50" />
                      <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">{contentLabel}</span>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-[10px] gap-1 text-muted-foreground hover:text-foreground"
                      onClick={() => copy(content!, 'content')}
                    >
                      {copied === 'content'
                        ? <><Check className="h-2.5 w-2.5" />Copied</>
                        : <><Copy className="h-2.5 w-2.5" />Copy</>
                      }
                    </Button>
                  </div>
                  <div className="px-6 py-4">
                    <pre className="text-xs leading-relaxed text-foreground/80 whitespace-pre-wrap font-mono">
                      <code>{content}</code>
                    </pre>
                  </div>
                </>
              )}

              {/* Empty fallback */}
              {rows.length === 0 && !content && (
                <div className="flex flex-col items-center justify-center py-20 text-muted-foreground/30">
                  <p className="text-xs">No additional details</p>
                </div>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------

function LoadingSkeleton() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="rounded-2xl border bg-card p-4 sm:p-5">
          <div className="mb-3 space-y-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-20" />
          </div>
          <Skeleton className="h-3 w-full mb-1" />
          <Skeleton className="h-3 w-4/5 mb-4" />
          <div className="flex justify-end">
            <Skeleton className="h-8 w-16" />
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filter pill
// ---------------------------------------------------------------------------

function FilterPill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <Button
      onClick={onClick}
      variant={active ? 'outline' : 'ghost'}
      size="sm"
      className={cn(!active && 'text-muted-foreground hover:text-foreground')}
    >
      {children}
    </Button>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyState({ hasFilters, onClear }: { hasFilters: boolean; onClear: () => void }) {
  if (hasFilters) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">
        No items match your filters.{' '}
        <Button onClick={onClear} variant="link" size="sm" className="h-auto p-0 ">
          Clear filters
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center justify-center py-20 rounded-xl border border-dashed border-border/50">
      <Blocks className="h-7 w-7 text-muted-foreground/30 mb-3" />
      <p className="text-sm font-medium text-foreground mb-1">Nothing here yet</p>
      <p className="text-xs text-muted-foreground text-center max-w-xs">
        Use the actions above to add agents, skills, commands, projects, or MCP servers.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Workspace Page
// ---------------------------------------------------------------------------

export default function WorkspacePage() {
  const [search, setSearch] = useState('');
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>('all');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<OpenCodeSettingsTab>('general');
  const [selectedItem, setSelectedItem] = useState<WorkspaceItem | null>(null);
  const createSession = useCreateOpenCodeSession();

  const openSettings = useCallback((tab: OpenCodeSettingsTab) => {
    setSettingsTab(tab);
    setSettingsOpen(true);
  }, []);

  const openComposer = useCallback(async (kind: WorkspaceComposerKind) => {
    const preset = COMPOSER_PRESETS[kind];
    try {
      const session = await createSession.mutateAsync({ title: preset.title });
      sessionStorage.setItem(`opencode_pending_prompt:${session.id}`, preset.prompt);
      openTabAndNavigate({
        id: session.id,
        title: preset.title,
        type: 'session',
        href: `/sessions/${session.id}`,
        serverId: useServerStore.getState().activeServerId,
      });
      requestAnimationFrame(() => window.dispatchEvent(new CustomEvent('focus-session-textarea')));
    } catch {
      toast.error('Failed to create session');
    }
  }, [createSession]);

  // Data — Kortix projects are the source of truth.
  // Skip the query when the project paradigm is off so the workspace
  // page in default mode never hits /kortix/projects (which 503s when sandbox-
  // side PROJECTS_ENABLED is also off).
  const { data: projects,  isLoading: lProjects, error: projectsError  } = useKortixProjects(undefined, { enabled: featureFlags.enableProjects });
  // Debug: log to browser console if projects fail to load
  if (typeof window !== 'undefined') {
    if (projectsError) console.error('[workspace] projects error:', projectsError);
    if (!lProjects && !projectsError && !projects && featureFlags.enableProjects) console.warn('[workspace] projects: no data, no error, not loading');
  }
  const { data: agents,    isLoading: lAgents    } = useOpenCodeAgents();
  const { data: skills,    isLoading: lSkills    } = useSkills();
  const { data: commands,  isLoading: lCommands  } = useOpenCodeCommands();
  const { data: toolIds,   isLoading: lTools     } = useOpenCodeToolIds();
  const { data: mcpStatus, isLoading: lMcp       } = useOpenCodeMcpStatus();
  const { data: connectors, isLoading: lConnectors } = useKortixConnectors();

  const isLoading = lProjects || lAgents || lSkills || lCommands || lTools || lMcp || lConnectors;

  const allItems = useMemo<WorkspaceItem[]>(() => {
    const items: WorkspaceItem[] = [];

    // Projects only appear when the project paradigm is enabled.
    if (featureFlags.enableProjects && projects && Array.isArray(projects)) {
      const sorted = [...projects].sort((a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );
      for (const p of sorted) {
        items.push({
          id: `project:${p.id}`,
          name: p.name,
          description: p.path && p.path !== '/' ? p.path : undefined,
          kind: 'project',
          scope: 'project',
          raw: p as any,
        });
      }
    }

    // 'project' scope means the item lives inside the workspace's `.opencode/`
    // dir (vs `/.config/` for global, `/.claude/` etc for external). When the
    // project paradigm is off there is no user-facing concept of a
    // "project" so we collapse the label to 'global' — same items, same
    // location, just no jargon.
    const localScope: ItemScope = featureFlags.enableProjects ? 'project' : 'global';

    // Project-only agents (orchestrator/project-maintainer/worker/project-manager)
    // are hidden when the project paradigm is off — their bodies still
    // reference project tools that aren't registered in that mode. Keep in
    // sync with use-visible-agents.ts:PROJECT_ONLY_AGENTS.
    const projectOnlyAgents = new Set(['project-manager']);
    agents?.filter((a) => !a.hidden && (featureFlags.enableProjects || !projectOnlyAgents.has(a.name))).forEach((a) => {
      items.push({ id: `agent:${a.name}`, name: a.name, description: a.description, kind: 'agent', scope: localScope, meta: a.model?.modelID, raw: a });
    });

    skills?.filter((s) => !(s as any).hidden).forEach((s) => {
      const src = getSkillSource(s.location);
      const scope: ItemScope = src === 'project' ? localScope : src === 'global' ? 'global' : 'external';
      items.push({ id: `skill:${s.name}`, name: s.name, description: s.description, kind: 'skill', scope, raw: s });
    });

    commands?.filter((c) => !(c as any).hidden && !c.subtask).forEach((c) => {
      const cs = commandScope(c.source);
      items.push({ id: `command:${c.name}`, name: `/${c.name}`, description: c.description, kind: 'command', scope: cs === 'project' ? localScope : cs, meta: c.agent, raw: c });
    });

    if (toolIds) {
      [...new Set(toolIds)].filter((id) => !id.startsWith('_') && !id.startsWith('.')).forEach((id) => {
        const isMcp = id.startsWith('mcp_');
        items.push({ id: `tool:${id}`, name: isMcp ? mcpToolName(id) : id, kind: 'tool', scope: isMcp ? 'external' : 'built-in', meta: isMcp ? mcpServerName(id) : undefined, raw: { toolId: id, server: isMcp ? mcpServerName(id) : undefined } });
      });
    }

    if (mcpStatus) {
      Object.entries(mcpStatus).filter(([, s]) => s.status !== 'disabled').forEach(([name, status]) => {
        const label = status.status === 'connected' ? 'Connected' : status.status === 'failed' ? 'Failed' : status.status === 'needs_auth' ? 'Needs Auth' : 'Pending';
        items.push({ id: `mcp:${name}`, name, description: status.status === 'failed' ? (status as any).error : undefined, kind: 'mcp', scope: 'external', meta: label, raw: { serverName: name, status } });
      });
    }

    if (connectors && Array.isArray(connectors)) {
      for (const c of connectors) {
        items.push({
          id: `connector:${c.id}`,
          name: c.name,
          description: c.description || undefined,
          kind: 'connector',
          scope: localScope,
          meta: c.source || 'custom',
          raw: c,
        });
      }
    }

    return items;
  }, [projects, agents, skills, commands, toolIds, mcpStatus, connectors]);

  const kindCounts = useMemo(() => {
    const c: Record<KindFilter, number> = { all: allItems.length, project: 0, agent: 0, skill: 0, command: 0, tool: 0, mcp: 0, connector: 0 };
    allItems.forEach((i) => c[i.kind]++);
    return c;
  }, [allItems]);

  const scopeCounts = useMemo(() => {
    const c: Record<ScopeFilter, number> = { all: 0, project: 0, global: 0, external: 0, 'built-in': 0 };
    const base = kindFilter === 'all' ? allItems : allItems.filter((i) => i.kind === kindFilter);
    c.all = base.length;
    base.forEach((i) => c[i.scope]++);
    return c;
  }, [allItems, kindFilter]);

  const filteredItems = useMemo(() => {
    let r = allItems;
    if (kindFilter !== 'all') r = r.filter((i) => i.kind === kindFilter);
    if (scopeFilter !== 'all') r = r.filter((i) => i.scope === scopeFilter);
    if (search.trim()) {
      const q = search.toLowerCase().trim();
      r = r.filter((i) => i.name.toLowerCase().includes(q) || i.description?.toLowerCase().includes(q) || i.meta?.toLowerCase().includes(q));
    }
    return r;
  }, [allItems, kindFilter, scopeFilter, search]);

  const activeScopeTabs = useMemo(() => {
    const tabs: { value: ScopeFilter; label: string }[] = [{ value: 'all', label: 'All' }];
    if (scopeCounts.project > 0)    tabs.push({ value: 'project',    label: 'Project' });
    if (scopeCounts.global > 0)     tabs.push({ value: 'global',     label: 'Global' });
    if (scopeCounts.external > 0)   tabs.push({ value: 'external',   label: 'External' });
    if (scopeCounts['built-in'] > 0) tabs.push({ value: 'built-in',  label: 'Built-in' });
    return tabs;
  }, [scopeCounts]);

  const hasFilters = search.trim() !== '' || kindFilter !== 'all' || scopeFilter !== 'all';
  const clearFilters = () => { setSearch(''); setKindFilter('all'); setScopeFilter('all'); };

  // Projects tab is filtered out below when the project paradigm is off.
  // Kept in this list so the tuple type stays stable for downstream `kindCounts`.
  const kindTabsAll = [
    { value: 'all'       as KindFilter, label: 'All' },
    { value: 'project'   as KindFilter, label: 'Projects' },
    { value: 'agent'     as KindFilter, label: 'Agents' },
    { value: 'skill'     as KindFilter, label: 'Skills' },
    { value: 'command'   as KindFilter, label: 'Commands' },
    { value: 'tool'      as KindFilter, label: 'Tools' },
    { value: 'mcp'       as KindFilter, label: 'MCP' },
    { value: 'connector' as KindFilter, label: 'Connectors' },
  ] as const;
  const kindTabs = featureFlags.enableProjects
    ? kindTabsAll
    : kindTabsAll.filter((t) => t.value !== 'project');

  return (
    <>
      <div className="flex-1 overflow-y-auto">
        <div className="container mx-auto max-w-7xl space-y-5 px-3 py-5 sm:px-4 sm:py-6 animate-in fade-in-0 slide-in-from-bottom-2 duration-300">
          {/* Header — title + actions in one row, like /settings/* pages.
              The tab bar already says "Workspace" so no need for a giant
              banner; this keeps actions one click away. */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <h1 className="text-lg sm:text-xl font-semibold">Workspace</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Agents, skills, commands, tools, and connectors.
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" disabled={createSession.isPending}>
                    {createSession.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Plus className="h-4 w-4" />
                    )}
                    New
                    <ChevronDown className="h-3 w-3 opacity-60" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
                  <DropdownMenuItem onClick={() => openComposer('agent')}>
                    <Bot className="mr-2 h-3.5 w-3.5" />
                    Agent
                    <span className="ml-auto text-[10px] text-muted-foreground/50 tabular-nums">
                      {kindCounts.agent}
                    </span>
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => openComposer('skill')}>
                    <Sparkles className="mr-2 h-3.5 w-3.5" />
                    Skill
                    <span className="ml-auto text-[10px] text-muted-foreground/50 tabular-nums">
                      {kindCounts.skill}
                    </span>
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => openComposer('command')}>
                    <Terminal className="mr-2 h-3.5 w-3.5" />
                    Command
                    <span className="ml-auto text-[10px] text-muted-foreground/50 tabular-nums">
                      {kindCounts.command}
                    </span>
                  </DropdownMenuItem>
                  {featureFlags.enableProjects && (
                    <DropdownMenuItem onClick={() => openComposer('project')}>
                      <FolderOpen className="mr-2 h-3.5 w-3.5" />
                      Project
                      <span className="ml-auto text-[10px] text-muted-foreground/50 tabular-nums">
                        {kindCounts.project}
                      </span>
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => openSettings('mcp')}>
                    <Plug className="mr-2 h-3.5 w-3.5" />
                    MCP server
                    <span className="ml-auto text-[10px] text-muted-foreground/50 tabular-nums">
                      {kindCounts.mcp}
                    </span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>

              <Button
                variant="outline"
                size="sm"
                onClick={() => openSettings('general')}
              >
                <Settings className="h-4 w-4" />
                Settings
              </Button>
            </div>
          </div>

          {/* Filters — search + kind tabs in one row; scope sub-filter below
              when present. Active filter pill shows the count, so we drop
              the "ALL ITEMS 190" header that used to live above the grid. */}
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <PageSearchBar
                value={search}
                onChange={setSearch}
                placeholder="Search..."
                className="max-w-sm flex-1 sm:flex-initial"
              />

              <FilterBar className="hidden lg:inline-flex">
                {kindTabs.map((tab) => (
                  <FilterBarItem
                    key={tab.value}
                    value={tab.value}
                    onClick={() => { setKindFilter(tab.value); setScopeFilter('all'); }}
                    data-state={kindFilter === tab.value ? 'active' : 'inactive'}
                  >
                    {tab.label}
                    {kindCounts[tab.value] > 0 && (
                      <span className="ml-1 opacity-50 tabular-nums">{kindCounts[tab.value]}</span>
                    )}
                  </FilterBarItem>
                ))}
              </FilterBar>

              <select
                value={kindFilter}
                onChange={(e) => { setKindFilter(e.target.value as KindFilter); setScopeFilter('all'); }}
                className="lg:hidden h-9 rounded-lg border border-input bg-card px-3 text-sm cursor-pointer"
              >
                {kindTabs.map((tab) => (
                  <option key={tab.value} value={tab.value}>{tab.label} ({kindCounts[tab.value]})</option>
                ))}
              </select>
            </div>

            {!isLoading && activeScopeTabs.length > 2 && (
              <FilterBar className="w-fit">
                {activeScopeTabs.map((tab) => (
                  <FilterBarItem
                    key={tab.value}
                    value={tab.value}
                    onClick={() => setScopeFilter(tab.value)}
                    data-state={scopeFilter === tab.value ? 'active' : 'inactive'}
                  >
                    {tab.label}{' '}
                    <span className="ml-1 opacity-50 tabular-nums">{scopeCounts[tab.value]}</span>
                  </FilterBarItem>
                ))}
              </FilterBar>
            )}
          </div>

          <OpenCodeSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} initialTab={settingsTab} />

          {/* Grid */}
          <div className="pb-8">
            {isLoading ? (
              <LoadingSkeleton />
            ) : allItems.length === 0 ? (
              <EmptyState hasFilters={false} onClear={clearFilters} />
            ) : filteredItems.length === 0 ? (
              <EmptyState hasFilters={hasFilters} onClear={clearFilters} />
            ) : (
              <AnimatePresence mode="popLayout">
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                  {filteredItems.map((item, index) => (
                    <WorkspaceItemCard
                      key={item.id}
                      item={{
                        id: item.id,
                        name: item.name,
                        description: item.description,
                        kindLabel: KIND_CONFIG[item.kind].label,
                        meta: item.meta ?? SCOPE_LABEL[item.scope],
                        mono: item.kind === 'command',
                      }}
                      index={index}
                      onClick={() => {
                        if (item.kind === 'project' && item.raw) {
                          const proj = item.raw as Project;
                          openTabAndNavigate({ id: `project:${proj.id}`, title: item.name, type: 'project', href: `/projects/${encodeURIComponent(proj.id)}` });
                        } else {
                          setSelectedItem(item);
                        }
                      }}
                      actions={
                        <Button
                          variant="ghost"
                          className="text-muted-foreground hover:text-foreground h-8 px-2.5 text-xs"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (item.kind === 'project' && item.raw) {
                              const proj = item.raw as Project;
                              openTabAndNavigate({ id: `project:${proj.id}`, title: item.name, type: 'project', href: `/projects/${encodeURIComponent(proj.id)}` });
                            } else {
                              setSelectedItem(item);
                            }
                          }}
                        >
                          View
                        </Button>
                      }
                    />
                  ))}
                </div>
              </AnimatePresence>
            )}
          </div>
        </div>
      </div>

      {/* Detail sheet */}
      <DetailSheet
        item={selectedItem}
        open={Boolean(selectedItem)}
        onOpenChange={(open) => { if (!open) setSelectedItem(null); }}
      />
    </>
  );
}

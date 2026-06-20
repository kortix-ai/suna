'use client';

import { useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { PageSearchBar } from '@/components/ui/page-search-bar';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { FilterBar, FilterBarItem } from '@/components/ui/tabs';
import { WorkspaceItemCard } from '@/components/ui/workspace-item-card';
import {
  OpenCodeSettingsDialog,
  type OpenCodeSettingsTab,
} from '@/features/session/opencode-settings-dialog';
import { useSkills } from '@/features/skills/hooks';
import { getSkillSource, type Skill } from '@/features/skills/types';
import {
  useCreateOpenCodeSession,
  useOpenCodeAgents,
  useOpenCodeCommands,
  useOpenCodeMcpStatus,
  useOpenCodeToolIds,
  type Agent,
  type Command,
  type McpStatus,
} from '@/hooks/opencode/use-opencode-sessions';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { useServerStore } from '@/stores/server-store';
import { openTabAndNavigate } from '@/stores/tab-store';
import {
  Blocks,
  Bot,
  Check,
  ChevronDown,
  Copy,
  FileText,
  Loader2,
  Plug,
  Plus,
  Settings,
  Sparkles,
  Terminal,
  Wrench,
} from 'lucide-react';
import { AnimatePresence } from 'motion/react';
import { useCallback, useMemo, useState } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ItemKind = 'agent' | 'skill' | 'command' | 'tool' | 'mcp';
type ItemScope = 'project' | 'global' | 'external' | 'built-in';
type KindFilter = 'all' | ItemKind;
type ScopeFilter = 'all' | ItemScope;
type WorkspaceComposerKind = 'agent' | 'skill' | 'command';

interface WorkspaceItem {
  id: string;
  name: string;
  description?: string;
  kind: ItemKind;
  scope: ItemScope;
  meta?: string;
  raw?:
    | Agent
    | Skill
    | Command
    | { toolId: string; server?: string }
    | { serverName: string; status: McpStatus };
}

const COMPOSER_PRESETS: Record<WorkspaceComposerKind, { title: string; prompt: string }> = {
  agent: {
    title: 'New agent',
    prompt:
      "HEY let's build a new agent. Ask what job it should own, then scaffold it in the right workspace location and wire up any supporting skills.",
  },
  skill: {
    title: 'New skill',
    prompt:
      "HEY let's build a new skill. Ask what should trigger it, then create the SKILL.md and any supporting files in the right workspace location.",
  },
  command: {
    title: 'New command',
    prompt:
      "HEY let's build a new slash command. Ask what the command should do, then add it in the right workspace location and connect it to the correct agent.",
  },
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
  agent: { icon: Bot, label: 'Agent' },
  skill: { icon: Sparkles, label: 'Skill' },
  command: { icon: Terminal, label: 'Command' },
  tool: { icon: Wrench, label: 'Tool' },
  mcp: { icon: Plug, label: 'MCP' },
};

const SCOPE_LABEL: Record<ItemScope, string> = {
  project: 'Workspace',
  global: 'Global',
  external: 'External',
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
  const tHardcodedUi = useTranslations('hardcodedUi');
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
    if (a.model)
      rows.push({
        label: 'Model',
        value: `${a.model.providerID}/${a.model.modelID}`,
        mono: true,
      });
    rows.push({ label: 'Mode', value: a.mode });
    if (a.variant) rows.push({ label: 'Variant', value: a.variant });
    if (a.temperature !== undefined)
      rows.push({ label: 'Temperature', value: String(a.temperature) });
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
      rows.push({
        label: 'Error',
        value: (m.status as { error: string }).error,
      });
    }
  }
  const contentLabel =
    item?.kind === 'skill'
      ? 'SKILL.md'
      : item?.kind === 'command'
        ? 'template'
        : item?.kind === 'agent'
          ? 'system prompt'
          : 'content';

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 p-0 sm:max-w-lg [&>button:last-child]:hidden"
      >
        {item && (
          <>
            {/* Header */}
            <SheetHeader className="border-border/50 gap-0 space-y-0 border-b px-6 pt-6 pb-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <SheetTitle
                    className={cn('text-sm break-all', item.kind === 'command' && 'font-mono')}
                  >
                    {item.name}
                  </SheetTitle>
                  <SheetDescription className="sr-only">
                    {kindCfg.label}
                    {tHardcodedUi.raw('componentsPagesWorkspacePage.line204JsxTextDetailsFor')}{' '}
                    {item.name}
                  </SheetDescription>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <Badge variant="secondary" className="text-xs">
                      {kindCfg.label}
                    </Badge>
                    <Badge variant="secondary" className="text-xs">
                      {SCOPE_LABEL[item.scope]}
                    </Badge>
                    {item.meta && (
                      <span className="text-muted-foreground/50 text-xs">{item.meta}</span>
                    )}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-foreground h-7 shrink-0 gap-1 px-2.5 text-xs"
                  onClick={() => copy(item.name, 'name')}
                >
                  {copied === 'name' ? (
                    <>
                      <Check className="h-3 w-3" />
                      Copied
                    </>
                  ) : (
                    <>
                      <Copy className="h-3 w-3" />
                      Copy
                    </>
                  )}
                </Button>
              </div>
              {item.description && (
                <p className="text-muted-foreground mt-3 text-xs leading-relaxed">
                  {item.description}
                </p>
              )}
            </SheetHeader>

            {/* Scrollable body */}
            <div className="flex-1 overflow-y-auto">
              {/* Properties */}
              {rows.length > 0 && (
                <div className="px-6 py-5">
                  <p className="text-muted-foreground/60 mb-3 text-xs font-semibold tracking-widest uppercase">
                    Properties
                  </p>
                  <div className="space-y-3">
                    {rows.map((row) => (
                      <div key={row.label} className="grid grid-cols-[100px_1fr] gap-2">
                        <span className="text-muted-foreground text-xs">{row.label}</span>
                        <span
                          className={cn(
                            'text-foreground text-xs break-all',
                            row.mono && 'font-mono',
                          )}
                        >
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
                  <div className="border-border/50 bg-muted/30 flex items-center justify-between border-y px-6 py-3">
                    <div className="flex items-center gap-2">
                      <FileText className="text-muted-foreground/50 h-3 w-3" />
                      <span className="text-muted-foreground/60 text-xs font-semibold tracking-widest uppercase">
                        {contentLabel}
                      </span>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground hover:text-foreground h-6 gap-1 px-2 text-xs"
                      onClick={() => copy(content!, 'content')}
                    >
                      {copied === 'content' ? (
                        <>
                          <Check className="h-2.5 w-2.5" />
                          Copied
                        </>
                      ) : (
                        <>
                          <Copy className="h-2.5 w-2.5" />
                          Copy
                        </>
                      )}
                    </Button>
                  </div>
                  <div className="px-6 py-4">
                    <pre className="text-foreground/80 font-mono text-xs leading-relaxed whitespace-pre-wrap">
                      <code>{content}</code>
                    </pre>
                  </div>
                </>
              )}

              {/* Empty fallback */}
              {rows.length === 0 && !content && (
                <div className="text-muted-foreground/30 flex flex-col items-center justify-center py-20">
                  <p className="text-xs">
                    {tHardcodedUi.raw(
                      'componentsPagesWorkspacePage.line280JsxTextNoAdditionalDetails',
                    )}
                  </p>
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
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="bg-card rounded-2xl border p-4 sm:p-5">
          <div className="mb-3 space-y-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-20" />
          </div>
          <Skeleton className="mb-1 h-3 w-full" />
          <Skeleton className="mb-4 h-3 w-4/5" />
          <div className="flex justify-end">
            <Skeleton className="h-8 w-16" />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ hasFilters, onClear }: { hasFilters: boolean; onClear: () => void }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  if (hasFilters) {
    return (
      <div className="text-muted-foreground py-12 text-center text-sm">
        {tHardcodedUi.raw('componentsPagesWorkspacePage.line340JsxTextNoItemsMatchYourFilters')}{' '}
        <Button onClick={onClear} variant="link" size="sm" className="h-auto p-0">
          {tHardcodedUi.raw('componentsPagesWorkspacePage.line342JsxTextClearFilters')}
        </Button>
      </div>
    );
  }
  return (
    <div className="border-border/50 flex flex-col items-center justify-center rounded-2xl border border-dashed py-20">
      <Blocks className="text-muted-foreground/30 mb-3 h-7 w-7" />
      <p className="text-foreground mb-1 text-sm font-medium">
        {tHardcodedUi.raw('componentsPagesWorkspacePage.line350JsxTextNothingHereYet')}
      </p>
      <p className="text-muted-foreground max-w-xs text-center text-xs">
        {tHardcodedUi.raw(
          'componentsPagesWorkspacePage.line352JsxTextUseTheActionsAboveToAddAgentsSkills',
        )}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Workspace Page
// ---------------------------------------------------------------------------

export default function WorkspacePage() {
  const tHardcodedUi = useTranslations('hardcodedUi');
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

  const openComposer = useCallback(
    async (kind: WorkspaceComposerKind) => {
      const preset = COMPOSER_PRESETS[kind];
      try {
        const session = await createSession.mutateAsync({
          title: preset.title,
        });
        sessionStorage.setItem(`opencode_pending_prompt:${session.id}`, preset.prompt);
        openTabAndNavigate({
          id: session.id,
          title: preset.title,
          type: 'session',
          href: `/sessions/${session.id}`,
          serverId: useServerStore.getState().activeServerId,
        });
        requestAnimationFrame(() =>
          window.dispatchEvent(new CustomEvent('focus-session-textarea')),
        );
      } catch {
        toast.error('Failed to create session');
      }
    },
    [createSession],
  );

  // Data — workspace-global registries only. Historical projects stay in the
  // backend DB for compatibility, but the UI does not expose projects.
  const { data: agents, isLoading: lAgents } = useOpenCodeAgents();
  const { data: skills, isLoading: lSkills } = useSkills();
  const { data: commands, isLoading: lCommands } = useOpenCodeCommands();
  const { data: toolIds, isLoading: lTools } = useOpenCodeToolIds();
  const { data: mcpStatus, isLoading: lMcp } = useOpenCodeMcpStatus();

  const isLoading = lAgents || lSkills || lCommands || lTools || lMcp;

  const allItems = useMemo<WorkspaceItem[]>(() => {
    const items: WorkspaceItem[] = [];

    agents
      ?.filter((a) => !a.hidden)
      .forEach((a) => {
        items.push({
          id: `agent:${a.name}`,
          name: a.name,
          description: a.description,
          kind: 'agent',
          scope: 'project',
          meta: a.model?.modelID,
          raw: a,
        });
      });

    skills
      ?.filter((s) => !(s as any).hidden)
      .forEach((s) => {
        const src = getSkillSource(s.location);
        const scope: ItemScope =
          src === 'project' ? 'project' : src === 'global' ? 'global' : 'external';
        items.push({
          id: `skill:${s.name}`,
          name: s.name,
          description: s.description,
          kind: 'skill',
          scope,
          raw: s,
        });
      });

    commands
      ?.filter((c) => !(c as any).hidden && !c.subtask)
      .forEach((c) => {
        const cs = commandScope(c.source);
        items.push({
          id: `command:${c.name}`,
          name: `/${c.name}`,
          description: c.description,
          kind: 'command',
          scope: cs === 'project' ? 'project' : cs,
          meta: c.agent,
          raw: c,
        });
      });

    if (toolIds) {
      [...new Set(toolIds)]
        .filter((id) => !id.startsWith('_') && !id.startsWith('.'))
        .forEach((id) => {
          const isMcp = id.startsWith('mcp_');
          items.push({
            id: `tool:${id}`,
            name: isMcp ? mcpToolName(id) : id,
            kind: 'tool',
            scope: isMcp ? 'external' : 'built-in',
            meta: isMcp ? mcpServerName(id) : undefined,
            raw: { toolId: id, server: isMcp ? mcpServerName(id) : undefined },
          });
        });
    }

    if (mcpStatus) {
      Object.entries(mcpStatus)
        .filter(([, s]) => s.status !== 'disabled')
        .forEach(([name, status]) => {
          const label =
            status.status === 'connected'
              ? 'Connected'
              : status.status === 'failed'
                ? 'Failed'
                : status.status === 'needs_auth'
                  ? 'Needs Auth'
                  : 'Pending';
          items.push({
            id: `mcp:${name}`,
            name,
            description: status.status === 'failed' ? (status as any).error : undefined,
            kind: 'mcp',
            scope: 'external',
            meta: label,
            raw: { serverName: name, status },
          });
        });
    }

    return items;
  }, [agents, skills, commands, toolIds, mcpStatus]);

  const kindCounts = useMemo(() => {
    const c: Record<KindFilter, number> = {
      all: allItems.length,
      agent: 0,
      skill: 0,
      command: 0,
      tool: 0,
      mcp: 0,
    };
    allItems.forEach((i) => c[i.kind]++);
    return c;
  }, [allItems]);

  const scopeCounts = useMemo(() => {
    const c: Record<ScopeFilter, number> = {
      all: 0,
      project: 0,
      global: 0,
      external: 0,
      'built-in': 0,
    };
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
      r = r.filter(
        (i) =>
          i.name.toLowerCase().includes(q) ||
          i.description?.toLowerCase().includes(q) ||
          i.meta?.toLowerCase().includes(q),
      );
    }
    return r;
  }, [allItems, kindFilter, scopeFilter, search]);

  const activeScopeTabs = useMemo(() => {
    const tabs: { value: ScopeFilter; label: string }[] = [{ value: 'all', label: 'All' }];
    if (scopeCounts.project > 0) tabs.push({ value: 'project', label: 'Workspace' });
    if (scopeCounts.global > 0) tabs.push({ value: 'global', label: 'Global' });
    if (scopeCounts.external > 0) tabs.push({ value: 'external', label: 'External' });
    if (scopeCounts['built-in'] > 0) tabs.push({ value: 'built-in', label: 'Built-in' });
    return tabs;
  }, [scopeCounts]);

  const hasFilters = search.trim() !== '' || kindFilter !== 'all' || scopeFilter !== 'all';
  const clearFilters = () => {
    setSearch('');
    setKindFilter('all');
    setScopeFilter('all');
  };

  const quickActions = [
    {
      title: 'New agent',
      desc: 'Scaffold a new agent in your workspace',
      meta: `${kindCounts.agent} live`,
      icon: Bot,
      kind: 'agent' as WorkspaceComposerKind,
    },
    {
      title: 'New skill',
      desc: 'Build a skill with the right trigger and file layout',
      meta: `${kindCounts.skill} live`,
      icon: Sparkles,
      kind: 'skill' as WorkspaceComposerKind,
    },
    {
      title: 'New command',
      desc: 'Create a slash command and wire it to an agent',
      meta: `${kindCounts.command} live`,
      icon: Terminal,
      kind: 'command' as WorkspaceComposerKind,
    },
  ];

  const kindTabs = [
    { value: 'all' as KindFilter, label: 'All' },
    { value: 'agent' as KindFilter, label: 'Agents' },
    { value: 'skill' as KindFilter, label: 'Skills' },
    { value: 'command' as KindFilter, label: 'Commands' },
    { value: 'tool' as KindFilter, label: 'Tools' },
    { value: 'mcp' as KindFilter, label: 'MCP' },
  ] as const;
  return (
    <>
      <div className="flex-1 overflow-y-auto">
        <div className="animate-in fade-in-0 slide-in-from-bottom-2 container mx-auto max-w-7xl space-y-5 px-3 py-5 duration-300 sm:px-4 sm:py-6">
          {/* Header — title + actions in one row, like /settings/* pages.
              The tab bar already says "Workspace" so no need for a giant
              banner; this keeps actions one click away. */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <h1 className="text-lg font-semibold sm:text-xl">Workspace</h1>
              <p className="text-muted-foreground mt-1 text-sm">
                {tHardcodedUi.raw(
                  'componentsPagesWorkspacePage.line501JsxTextAgentsSkillsCommandsToolsAndMcpServers',
                )}
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
                    <span className="text-muted-foreground/50 ml-auto text-xs tabular-nums">
                      {kindCounts.agent}
                    </span>
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => openComposer('skill')}>
                    <Sparkles className="mr-2 h-3.5 w-3.5" />
                    Skill
                    <span className="text-muted-foreground/50 ml-auto text-xs tabular-nums">
                      {kindCounts.skill}
                    </span>
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => openComposer('command')}>
                    <Terminal className="mr-2 h-3.5 w-3.5" />
                    Command
                    <span className="text-muted-foreground/50 ml-auto text-xs tabular-nums">
                      {kindCounts.command}
                    </span>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => openSettings('mcp')}>
                    <Plug className="mr-2 h-3.5 w-3.5" />
                    {tHardcodedUi.raw('componentsPagesWorkspacePage.line542JsxTextMcpServer')}
                    <span className="text-muted-foreground/50 ml-auto text-xs tabular-nums">
                      {kindCounts.mcp}
                    </span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>

              <Button variant="outline" size="sm" onClick={() => openSettings('general')}>
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
                    onClick={() => {
                      setKindFilter(tab.value);
                      setScopeFilter('all');
                    }}
                    data-state={kindFilter === tab.value ? 'active' : 'inactive'}
                  >
                    {tab.label}
                    {kindCounts[tab.value] > 0 && (
                      <span className="ml-1 tabular-nums opacity-50">{kindCounts[tab.value]}</span>
                    )}
                  </FilterBarItem>
                ))}
              </FilterBar>

              <select
                value={kindFilter}
                onChange={(e) => {
                  setKindFilter(e.target.value as KindFilter);
                  setScopeFilter('all');
                }}
                className="border-input bg-card h-9 cursor-pointer rounded-2xl border px-3 text-sm lg:hidden"
              >
                {kindTabs.map((tab) => (
                  <option key={tab.value} value={tab.value}>
                    {tab.label} ({kindCounts[tab.value]})
                  </option>
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
                    <span className="ml-1 tabular-nums opacity-50">{scopeCounts[tab.value]}</span>
                  </FilterBarItem>
                ))}
              </FilterBar>
            )}
          </div>

          <OpenCodeSettingsDialog
            open={settingsOpen}
            onOpenChange={setSettingsOpen}
            initialTab={settingsTab}
          />

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
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
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
                        setSelectedItem(item);
                      }}
                      actions={
                        <Button
                          variant="ghost"
                          className="text-muted-foreground hover:text-foreground h-8 px-2.5 text-xs"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedItem(item);
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
        onOpenChange={(open) => {
          if (!open) setSelectedItem(null);
        }}
      />
    </>
  );
}

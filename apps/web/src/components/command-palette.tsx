'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, usePathname, useParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { normalizeAppPathname } from '@/lib/instance-routes';
import {
  createProjectSession,
  listAccounts,
  listProjectsForAccount,
  listProjectSessions,
  searchProjectFiles,
  type KortixAccount,
  type KortixProject,
  type ProjectSession,
} from '@/lib/projects-client';
import { useProjectSessionTabsStore } from '@/stores/project-session-tabs-store';
import { useCurrentAccountStore } from '@/stores/current-account-store';
import { useCustomizeStore } from '@/stores/customize-store';
import { parseCustomizeSection } from '@/lib/customize-sections';
import {
  Loader2,
  MessageCircle,
  Search,
  PanelLeftClose,
  PanelLeftIcon,
  ArrowUp,
  ArrowDown,
  CornerDownLeft,
  Bot,
  Cpu,
  ChevronRight,
  ArrowLeft,
  Check,
  Folder,
  FolderGit2,
  FileText,
  Hash,
  Globe,
  Users,
} from 'lucide-react';

import {
  getItemsForSurface,
  type MenuItemDef,
  type SettingsTabId,
} from '@/lib/menu-registry';

import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandFooter,
  CommandKbd,
} from '@/components/ui/command';
import { SidebarContext } from '@/components/ui/sidebar';
import {
  useOpenCodeAgents,
  useOpenCodeProviders,
} from '@/hooks/opencode/use-opencode-sessions';
import { toast } from '@/lib/toast';
import { featureFlags } from '@/lib/feature-flags';
import { useServerStore } from '@/stores/server-store';
import { authenticatedFetch } from '@/lib/auth-token';

import { useCreateOpenCodeSession } from '@/hooks/opencode/use-opencode-sessions';
import { openTabAndNavigate } from '@/stores/tab-store';
import { useCreatePty } from '@/hooks/opencode/use-opencode-pty';
import { CompactDialog } from '@/components/session/compact-dialog';
import { DiffDialog } from '@/components/session/diff-dialog';
import { UserSettingsModal } from '@/components/settings/user-settings-modal';
import { useNewInstanceModalStore } from '@/stores/pricing-modal-store';
import { createClient } from '@/lib/supabase/client';
import { isBillingEnabled } from '@/lib/config';
import { useTheme } from 'next-themes';
import { clearUserLocalStorage } from '@/lib/utils/clear-local-storage';
import { clearSessionIDBCache } from '@/lib/idb-sync-cache';
import { flattenModels } from '@/components/session/session-chat-input';
import { useModelStore } from '@/hooks/opencode/use-model-store';
import {
  PROVIDER_LABELS,
  ProviderLogo,
  MODEL_SELECTOR_PROVIDER_IDS,
} from '@/components/providers/provider-branding';
import { useOpenCodeMessages } from '@/hooks/opencode/use-opencode-sessions';
import { useMessageJumpStore } from '@/stores/message-jump-store';
import { groupMessagesIntoTurns, isTextPart, type TextPart } from '@/ui';
import { stripKortixSystemTags } from '@/lib/utils/kortix-system-tags';

import {
  parseLocalhostUrl,
  toInternalUrl,
  normalizeExternalInput,
  buildWebProxyUrl,
} from '@/lib/utils/sandbox-url';
import { enrichPreviewMetadata } from '@/lib/utils/session-context';
import { useSandboxProxy } from '@/hooks/use-sandbox-proxy';

// ============================================================================
// Types
// ============================================================================

type PalettePage = 'root' | 'agents' | 'models' | 'messages' | 'projects' | 'accounts' | 'sessions' | 'files';

// ============================================================================
// Helpers
// ============================================================================

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

/**
 * Sanitize a value string for use as a cmdk CommandItem value.
 * cmdk sets data-value then calls querySelector('[data-value="..."]'),
 * so any characters that break CSS attribute selectors must be removed.
 */
function sanitizeCmdkValue(value: string): string {
  // Remove double quotes, single quotes, backslashes, brackets — all CSS selector breakers
  return value.replace(/["'\\[\]]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Legacy global-workspace registry items that don't belong in the new
// project-shell palette (they point at the old tabbed shell routes). The new
// project + app nav items (proj-*, nav-*) replace them. Kept in the registry
// because the legacy right/left sidebars still render them.
const LEGACY_PALETTE_HIDDEN = new Set([
  'workspace', 'dashboard', 'scheduled-tasks', 'files', 'tunnel',
  'running-services-cmd', 'agent-browser-cmd', 'internal-browser-cmd', 'desktop-cmd',
  'templates', 'changelog', 'credits-explained', 'secrets-manager', 'api-keys',
  'llm-providers', 'open-terminal', 'restart-config', 'restart-full', 'ssh-quick',
]);

// Registry nav items that open a sub-picker page instead of navigating directly.
const SUBMENU_PAGE_BY_ID: Record<string, PalettePage> = {
  'nav-projects': 'projects',
  'nav-accounts': 'accounts',
  'proj-sessions': 'sessions',
};

// ============================================================================
// FileSearchPage — git-backed search over the active project's repo.
// Filenames by default; prefix with ">" to grep file contents (server-side
// `git grep`). Replaces the legacy sandbox /workspace search.
// ============================================================================

function FileSearchPage({
  projectId,
  query,
  onSelect,
}: {
  projectId: string;
  query: string;
  onSelect: (filePath: string, lineNumber?: number) => void;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const isContent = query.trimStart().startsWith('>');
  const effectiveQuery = (isContent ? query.replace(/^\s*>\s*/, '') : query).trim();
  const enabled = effectiveQuery.length >= 2;

  const { data, isLoading } = useQuery({
    queryKey: ['project-file-search', projectId, effectiveQuery, isContent],
    queryFn: () => searchProjectFiles(projectId, effectiveQuery, { content: isContent, limit: 50 }),
    enabled,
    staleTime: 15_000,
  });

  if (!enabled) {
    return (
      <div className="flex flex-col items-center gap-3 py-12">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted/30">
          <Search className="h-4 w-4 text-muted-foreground/40" />
        </div>
        <div className="space-y-1 text-center">
          <p className="text-sm text-muted-foreground/60">{tHardcodedUi.raw('componentsCommandPalette.line183JsxTextSearchFilesInThisProjectSRepo')}</p>
          <p className="text-xs text-muted-foreground/30">
            {tHardcodedUi.raw('componentsCommandPalette.line185JsxTextPrefixWith')}{' '}
            <kbd className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{tHardcodedUi.raw('componentsCommandPalette.line186JsxTextText')}</kbd> {tHardcodedUi.raw('componentsCommandPalette.line186JsxTextToSearchFileContents')}</p>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center gap-2 py-10">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground/50" />
        <span className="text-sm text-muted-foreground/50">
          {isContent ? 'Searching file contents…' : 'Searching files…'}
        </span>
      </div>
    );
  }

  const results = data?.results ?? [];
  if (results.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-12" cmdk-empty="">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted/30">
          <Search className="h-4 w-4 text-muted-foreground/30" />
        </div>
        <span className="text-sm text-muted-foreground/60">
          No {isContent ? 'content matches' : 'files'} {tHardcodedUi.raw('componentsCommandPalette.line213JsxTextFor')}{effectiveQuery}{tHardcodedUi.raw('componentsCommandPalette.line213JsxTextText')}</span>
      </div>
    );
  }

  if (isContent) {
    const grouped = new Map<string, typeof results>();
    for (const r of results) {
      const arr = grouped.get(r.path) ?? [];
      arr.push(r);
      grouped.set(r.path, arr);
    }
    return (
      <>
        {Array.from(grouped.entries()).map(([filePath, matches]) => (
          <CommandGroup
            key={filePath}
            heading={
              <span className="inline-flex items-center gap-1.5 font-mono text-xs">
                <FileText className="h-3 w-3 shrink-0" />
                {filePath}
              </span>
            }
            forceMount
          >
            {matches.map((match, i) => (
              <CommandItem
                key={`${filePath}:${match.line_number}:${i}`}
                value={sanitizeCmdkValue(`content ${filePath} ${match.line_text} ${match.line_number}`)}
                onSelect={() => onSelect(filePath, match.line_number)}
              >
                <Hash className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />
                <span className="w-8 shrink-0 text-right text-xs tabular-nums text-muted-foreground/50">
                  {match.line_number}
                </span>
                <span className="flex-1 truncate font-mono text-sm text-muted-foreground/80">
                  {(match.line_text || '').trim()}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </>
    );
  }

  return (
    <CommandGroup heading={`Files (${results.length})`} forceMount>
      {results.map((item) => {
        const name = item.path.split('/').pop() || item.path;
        return (
          <CommandItem
            key={item.path}
            value={sanitizeCmdkValue(`file ${name} ${item.path}`)}
            onSelect={() => onSelect(item.path)}
          >
            <FileText className="h-4 w-4 shrink-0 text-muted-foreground/70" />
            <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
              <span className="truncate text-sm font-medium">{name}</span>
              <span className="min-w-0 flex-shrink truncate font-mono text-xs text-muted-foreground/35">
                {item.path}
              </span>
            </div>
          </CommandItem>
        );
      })}
    </CommandGroup>
  );
}

// ============================================================================
// MessagesPage — shows user messages for jump-to-message
// ============================================================================

function MessagesPage({
  sessionId,
  query,
  onSelect,
}: {
  sessionId: string;
  query: string;
  onSelect: (messageId: string) => void;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const { data: messages, isLoading } = useOpenCodeMessages(sessionId);

  const turns = useMemo(
    () => (messages ? groupMessagesIntoTurns(messages) : []),
    [messages],
  );

  const items = useMemo(() => {
    return turns
      .map((turn) => {
        const textParts = turn.userMessage.parts.filter(isTextPart) as TextPart[];
        const raw = textParts.map((p) => p.text).join(' ');
        const stripped = stripKortixSystemTags(raw).replace(/<[^>]+>/g, '').trim();
        return {
          id: turn.userMessage.info.id,
          text: stripped,
        };
      })
      .filter((item) => item.text.length > 0);
  }, [turns]);

  const filtered = useMemo(() => {
    if (!query.trim()) return items;
    const q = query.trim().toLowerCase();
    return items.filter((item) => (item.text || '').toLowerCase().includes(q));
  }, [items, query]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center gap-2 py-10">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground/50" />
        <span className="text-sm text-muted-foreground/50">{tHardcodedUi.raw('componentsCommandPalette.line328JsxTextLoadingMessages')}</span>
      </div>
    );
  }

  if (filtered.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-12">
        <div className="flex items-center justify-center h-10 w-10 rounded-full bg-muted/30">
          <MessageCircle className="h-4 w-4 text-muted-foreground/30" />
        </div>
        <span className="text-sm text-muted-foreground/60">
          {query ? `No messages matching "${query}"` : 'No messages in this session'}
        </span>
      </div>
    );
  }

  return (
    <CommandGroup heading={`Messages (${filtered.length})`} forceMount>
      {filtered.map((item, index) => (
        <CommandItem
          key={item.id}
          value={sanitizeCmdkValue(`message ${index} ${item.text.slice(0, 80)}`)}
          onSelect={() => onSelect(item.id)}
        >
          <MessageCircle className="h-3.5 w-3.5 text-muted-foreground/40 flex-shrink-0" />
          <span className="text-xs text-muted-foreground/50 tabular-nums w-6 text-right flex-shrink-0">
            #{index + 1}
          </span>
          <span className="truncate text-sm flex-1">
            {item.text.length > 80 ? `${item.text.slice(0, 80)}...` : item.text}
          </span>
        </CommandItem>
      ))}
    </CommandGroup>
  );
}

// ============================================================================
// Command Palette
// ============================================================================

export function CommandPalette() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState<PalettePage>('root');
  const [isCreating, setIsCreating] = useState(false);
  const [compactOpen, setCompactOpen] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTabId>('general');
  const openNewInstanceModal = useNewInstanceModalStore((s) => s.openNewInstanceModal);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const rawPathname = usePathname();
  const pathname = normalizeAppPathname(rawPathname);
  const params = useParams<{ id?: string; sessionId?: string }>();
  const queryClient = useQueryClient();
  const openProjectTab = useProjectSessionTabsStore((s) => s.openTab);
  // New project shell: /projects/[id]/... scopes navigation + "new session" to
  // the active project. Null in the legacy global shell.
  const projectId = rawPathname?.startsWith('/projects/') ? (params?.id ?? null) : null;
  const currentSessionId = useMemo(() => {
    if (params?.sessionId) return params.sessionId; // /projects/[id]/sessions/[sessionId]
    const match = pathname?.match(/^\/sessions\/([^/]+)/); // legacy global shell
    return match ? match[1] : null;
  }, [params?.sessionId, pathname]);
  // Read the sidebar context directly so the palette can mount anywhere
  // (AppHeader pages have no SidebarProvider). Sidebar actions no-op there.
  const sidebarCtx = useContext(SidebarContext);
  const sidebarOpen = sidebarCtx?.open ?? false;
  const { proxyUrl: buildProxyUrl, subdomainOpts } = useSandboxProxy();
  const createSession = useCreateOpenCodeSession();
  const createPty = useCreatePty();
  const { theme, setTheme } = useTheme();
  const billingEnabled = isBillingEnabled();

  // ── Data hooks ──
  const { data: agents } = useOpenCodeAgents();
  const { data: providers } = useOpenCodeProviders();

  // ── Project / account data for the switch sub-pickers ──
  const selectedAccountId = useCurrentAccountStore((s) => s.selectedAccountId);
  const { data: accountsList } = useQuery({
    queryKey: ['accounts'],
    queryFn: listAccounts,
    enabled: open,
    staleTime: 60_000,
  });
  const activeAccount =
    accountsList?.find((account) => account.account_id === selectedAccountId) ??
    accountsList?.[0] ??
    null;
  const activeAccountId = activeAccount?.account_id ?? null;
  const { data: projectsList } = useQuery({
    queryKey: ['projects', activeAccountId],
    queryFn: () => listProjectsForAccount(activeAccountId || undefined),
    enabled: open && !!activeAccountId,
    staleTime: 30_000,
  });
  const { data: projectSessionsList } = useQuery({
    queryKey: ['project-sessions', projectId],
    queryFn: () => listProjectSessions(projectId!),
    enabled: open && !!projectId,
    staleTime: 15_000,
  });

  // ── Derived: flat models ──
  const allModels = useMemo(() => flattenModels(providers), [providers]);
  const modelStore = useModelStore(allModels);

  // ── Current agent/model for the active session ──
  const currentAgentName = useMemo(() => {
    if (!currentSessionId) return undefined;
    return modelStore.getSessionAgentName(currentSessionId);
  }, [currentSessionId, modelStore]);

  const currentAgent = useMemo(() => {
    if (!currentAgentName || !agents) return agents?.[0];
    return agents.find((a) => a.name === currentAgentName) ?? agents[0];
  }, [currentAgentName, agents]);

  const currentModelKey = useMemo(() => {
    if (!currentAgent) return undefined;
    return modelStore.getSelectedModel(currentAgent.name);
  }, [currentAgent, modelStore]);

  const close = useCallback(() => setOpen(false), []);

  // ── Page navigation helpers ──
  const goToPage = useCallback((p: PalettePage, preserveQuery?: boolean) => {
    setPage(p);
    if (!preserveQuery) setQuery('');
  }, []);

  const goBack = useCallback(() => {
    setPage('root');
    setQuery('');
  }, []);

  const handleOpenTerminal = useCallback(async () => {
    try {
      const pty = await createPty.mutateAsync({
        env: { TERM: 'xterm-256color', COLORTERM: 'truecolor' },
      });
      openTabAndNavigate({
        id: `terminal:${pty.id}`,
        title: pty.title || pty.command || 'Terminal',
        type: 'terminal',
        href: `/terminal/${pty.id}`,
      });
    } catch {
      toast.error('Failed to open terminal');
    }
    close();
  }, [createPty, close]);

  // Global keyboard shortcut
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
      if (e.key === '`' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleOpenTerminal();
      }
    };
    document.addEventListener('keydown', down);
    return () => document.removeEventListener('keydown', down);
  }, [handleOpenTerminal]);

  // Reset when dialog closes
  useEffect(() => {
    if (!open) {
      setQuery('');
      setPage('root');
    }
  }, [open]);

  // Open straight to File Search (e.g. from the /files route).
  useEffect(() => {
    const openFileSearch = () => {
      setQuery('');
      setPage('files');
      setOpen(true);
    };
    window.addEventListener('kortix:open-file-search', openFileSearch);
    return () => window.removeEventListener('kortix:open-file-search', openFileSearch);
  }, []);

  // Backspace on empty query goes back to root
  useEffect(() => {
    if (page === 'root') return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Backspace' && query === '') {
        e.preventDefault();
        goBack();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [page, query, goBack]);

  // Fuzzy match helper
  const fuzzyMatch = useCallback((text: string, q: string): boolean => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const haystack = text.toLowerCase();
    return words.every((w) => haystack.includes(w));
  }, []);

  const hasQuery = query.trim().length > 0;
  const queryLongEnough = query.trim().length >= 2;
  // ── Palette items ──
  const allPaletteItems = useMemo(() => {
    return getItemsForSurface('commandPalette')
      .filter((item) => {
        if (LEGACY_PALETTE_HIDDEN.has(item.id)) return false;
        if (item.id === 'toggle-sidebar' && !sidebarCtx) return false;
        if (item.requiresBilling && !billingEnabled) return false;
        if (item.requiresSession && !currentSessionId) return false;
        if (item.requiresProject && !projectId) return false;
        return true;
      })
      // Resolve the {projectId} token in project-scoped hrefs.
      .map((item) =>
        item.href?.includes('{projectId}') && projectId
          ? { ...item, href: item.href.replaceAll('{projectId}', projectId) }
          : item,
      );
  }, [billingEnabled, currentSessionId, projectId, sidebarCtx]);

  // Filter navigation items client-side
  const filteredNavItems = useMemo(() => {
    if (!hasQuery) return allPaletteItems;
    const q = query.trim().toLowerCase();
    const words = q.split(/\s+/).filter(Boolean);
    return allPaletteItems.filter((item) => {
      const haystack = [
        item.label,
        item.id,
        item.group,
        item.keywords || '',
      ].join(' ').toLowerCase();
      return words.every((w) => haystack.includes(w));
    });
  }, [allPaletteItems, hasQuery, query]);

  // ── Submenu: agents ──
  // Project-only agents (orchestrator/project-maintainer/worker/project-manager)
  // are hidden from the palette when the project paradigm is off —
  // their bodies reference project tools that aren't registered in default
  // mode. Keep in sync with use-visible-agents.ts:PROJECT_ONLY_AGENTS.
  const visibleAgents = useMemo(() => {
    if (!agents) return [];
    const projectOnlyAgents = new Set(['project-manager']);
    return agents.filter(
      (a) => !a.hidden && (featureFlags.enableProjects || !projectOnlyAgents.has(a.name))
    );
  }, [agents]);

  const filteredAgents = useMemo(() => {
    if (!visibleAgents.length) return [];
    const q = query.trim().toLowerCase();
    return visibleAgents.filter((a) =>
      (a.name || '').toLowerCase().includes(q) || (a.description || '').toLowerCase().includes(q),
    );
  }, [visibleAgents, query]);

  const primaryAgents = useMemo(() => filteredAgents.filter((a) => a.mode !== 'subagent'), [filteredAgents]);
  const subAgents = useMemo(() => filteredAgents.filter((a) => a.mode === 'subagent'), [filteredAgents]);

  // ── Submenu: models (grouped by provider) ──
  const visibleModels = useMemo(() => {
    const q = query.trim().toLowerCase();
    return allModels
      .filter((m) => {
        if (!q && !modelStore.isVisible({ providerID: m.providerID, modelID: m.modelID })) return false;
        return (
          !q ||
          (m.modelName || '').toLowerCase().includes(q) ||
          (m.modelID || '').toLowerCase().includes(q) ||
          (m.providerName || '').toLowerCase().includes(q)
        );
      })
      .sort((a, b) => (a.modelName || '').localeCompare(b.modelName || ''));
  }, [allModels, query, modelStore]);

  const groupedModels = useMemo(() => {
    const groups = new Map<string, { providerID: string; providerName: string; models: typeof visibleModels }>();
    for (const m of visibleModels) {
      const existing = groups.get(m.providerID);
      if (existing) {
        existing.models.push(m);
      } else {
        groups.set(m.providerID, { providerID: m.providerID, providerName: PROVIDER_LABELS[m.providerID] || m.providerName, models: [m] });
      }
    }
    const entries = Array.from(groups.values());
    entries.sort((a, b) => {
      const ai = MODEL_SELECTOR_PROVIDER_IDS.indexOf(a.providerID);
      const bi = MODEL_SELECTOR_PROVIDER_IDS.indexOf(b.providerID);
      if (ai >= 0 && bi < 0) return -1;
      if (ai < 0 && bi >= 0) return 1;
      if (ai >= 0 && bi >= 0) return ai - bi;
      return a.providerName.localeCompare(b.providerName);
    });
    return entries;
  }, [visibleModels]);

  // ── "Change Agent" and "Change Model" virtual palette items ──
  const sessionActionItems = useMemo(() => {
    if (!hasQuery) return [];
    const q = query.trim().toLowerCase();
    const words = q.split(/\s+/).filter(Boolean);
    const items: { id: string; label: string; keywords: string; targetPage: PalettePage }[] = [];
    if (currentSessionId) {
      items.push({
        id: 'change-agent',
        label: 'Change Agent',
        keywords: 'change agent worker switch select bot assistant',
        targetPage: 'agents',
      });
      items.push({
        id: 'change-model',
        label: 'Change Model',
        keywords: 'change model llm switch select provider anthropic openai claude gpt',
        targetPage: 'models',
      });
      items.push({
        id: 'jump-to-message',
        label: 'Jump to Message',
        keywords: 'jump message go scroll navigate find conversation chat',
        targetPage: 'messages',
      });
    }
    return items.filter((item) => {
      const haystack = [item.label, item.keywords].join(' ').toLowerCase();
      return words.every((w) => haystack.includes(w));
    });
  }, [hasQuery, query, currentSessionId]);

  const hasNavResults = filteredNavItems.length > 0;
  const hasSessionActionResults = sessionActionItems.length > 0;

  // ── Handlers ──

  const handleNewSession = useCallback(async () => {
    if (isCreating) return;
    setIsCreating(true);
    try {
      if (projectId) {
        // New project shell — create a project session and route to it; the
        // tab bar picks it up from the URL.
        const session = await createProjectSession(projectId);
        queryClient.invalidateQueries({ queryKey: ['project-sessions', projectId] });
        openProjectTab(projectId, session.session_id);
        router.push(`/projects/${projectId}/sessions/${session.session_id}`);
        close();
      } else {
        const session = await createSession.mutateAsync();
        openTabAndNavigate({
          id: session.id,
          title: 'New session',
          type: 'session',
          href: `/sessions/${session.id}`,
        });
        requestAnimationFrame(() => {
          window.dispatchEvent(new CustomEvent('focus-session-textarea'));
        });
        close();
      }
    } catch {
      toast.error('Failed to create session');
    } finally {
      setIsCreating(false);
    }
  }, [isCreating, projectId, createSession, queryClient, openProjectTab, router, close]);

  // ── Switch sub-pickers: select handlers + filtered lists ──
  const setSelectedAccountId = useCurrentAccountStore((s) => s.setSelectedAccountId);

  const handleSelectProject = useCallback((p: KortixProject) => {
    router.push(`/projects/${p.project_id}`);
    close();
  }, [router, close]);

  const handleSelectAccount = useCallback((a: KortixAccount) => {
    setSelectedAccountId(a.account_id);
    router.push('/projects');
    close();
  }, [setSelectedAccountId, router, close]);

  const handleSelectProjectSession = useCallback((s: ProjectSession) => {
    if (!projectId) return close();
    openProjectTab(projectId, s.session_id);
    router.push(`/projects/${projectId}/sessions/${s.session_id}`);
    close();
  }, [projectId, openProjectTab, router, close]);

  const sessionName = (s: ProjectSession) =>
    s.name ||
    (typeof s.metadata?.session_name === 'string' ? s.metadata.session_name : '') ||
    s.branch_name ||
    s.session_id.slice(0, 8);

  // Projects sorted by most-recently-opened — reused for both the "Switch
  // Project" sub-picker and the global idle "Recent Projects" list.
  const sortedProjects = useMemo(
    () =>
      [...(projectsList ?? [])].sort((a, b) =>
        (b.last_opened_at || b.updated_at).localeCompare(a.last_opened_at || a.updated_at),
      ),
    [projectsList],
  );

  const filteredProjectsList = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (q ? sortedProjects.filter((p) => p.name.toLowerCase().includes(q)) : sortedProjects).slice(0, 50);
  }, [sortedProjects, query]);

  // Idle "Recent" lists. In a project we surface the project's own recent
  // sessions (current source: ['project-sessions', projectId]); in the global
  // shell there is no cross-project session feed, so we surface recent
  // projects instead.
  const recentProjectSessions = useMemo(() => {
    return [...(projectSessionsList ?? [])]
      .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
      .slice(0, 5);
  }, [projectSessionsList]);

  const recentProjects = useMemo(() => sortedProjects.slice(0, 5), [sortedProjects]);

  const filteredAccountsList = useMemo(() => {
    const q = query.trim().toLowerCase();
    const sorted = [...(accountsList ?? [])].sort((a, b) =>
      (a.name || '').localeCompare(b.name || ''),
    );
    return q ? sorted.filter((a) => (a.name || '').toLowerCase().includes(q)) : sorted;
  }, [accountsList, query]);

  const filteredProjectSessionsList = useMemo(() => {
    const q = query.trim().toLowerCase();
    const sorted = [...(projectSessionsList ?? [])].sort(
      (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
    );
    return (q ? sorted.filter((s) => sessionName(s).toLowerCase().includes(q)) : sorted).slice(0, 50);
  }, [projectSessionsList, query]);

  // ── Root-search result lists (current sources only) ──
  // In a project, free-text search hits the project's own sessions; in the
  // global shell it hits projects (there is no legacy global session feed).
  const rootSessionResults = useMemo(() => {
    if (!hasQuery || !projectId) return [];
    return filteredProjectSessionsList.slice(0, 8);
  }, [hasQuery, projectId, filteredProjectSessionsList]);

  const rootProjectResults = useMemo(() => {
    if (!hasQuery || projectId) return [];
    return filteredProjectsList.slice(0, 8);
  }, [hasQuery, projectId, filteredProjectsList]);

  const hasSessionResults = rootSessionResults.length > 0;
  const hasProjectResults = rootProjectResults.length > 0;
  const hasAnyResults =
    hasNavResults || hasSessionResults || hasProjectResults || hasSessionActionResults;

  const showNoResults = hasQuery && queryLongEnough && !hasAnyResults;

  const handleNavigate = useCallback(
    (path: string, label?: string) => {
      const type = path.startsWith('/settings')
        ? 'settings' as const
        : 'page' as const;
      openTabAndNavigate({
        id: `page:${path}`,
        title: label || path.split('/').pop() || '',
        type,
        href: path,
      }, router);
      close();
    },
    [router, close],
  );

  const handleSelectFile = useCallback(
    (_filePath: string, _lineNumber?: number) => {
      if (!projectId) return close();
      // Files live in the Customize overlay's Files section. Open it in place
      // (the explorer reads its own selection state; per-file/line deep focus
      // is a follow-up now that this no longer rides a URL).
      useCustomizeStore.getState().openCustomize('files');
      close();
    },
    [projectId, close],
  );

  const jumpToMessage = useMessageJumpStore((s) => s.jumpToMessage);

  const handleJumpToMessage = useCallback(
    (messageId: string) => {
      jumpToMessage(messageId);
      close();
    },
    [jumpToMessage, close],
  );

  // ── URL detection: localhost:PORT, http(s)://, or bare port ──
  const detectedUrl = useMemo(() => {
    const q = query.trim();
    if (!q) return null;

    // 1. localhost URL: "localhost:4200", "localhost:4200/api", "http://localhost:3000"
    const localhostParsed = parseLocalhostUrl(q.startsWith('http') ? q : `http://${q}`);
    if (localhostParsed) {
      return { kind: 'localhost' as const, ...localhostParsed };
    }

    // 2. Bare port number: "4200", "3000"
    if (/^\d{2,5}$/.test(q)) {
      const port = parseInt(q, 10);
      if (port >= 1 && port <= 65535) {
        return {
          kind: 'localhost' as const,
          originalUrl: `http://localhost:${port}/`,
          port,
          path: '/',
        };
      }
    }

    // 3. External URL: "https://github.com", "google.com", "example.com/path"
    const normalized = normalizeExternalInput(q);
    if (normalized) {
      // Filter out filenames that look like domains (e.g. "package.json", "style.css")
      // Only exclude if the "domain" ends with a known code/asset file extension
      // and has no slash (i.e. it's just "name.ext", not "domain.com/path")
      if (!q.includes('/')) {
        const ext = q.split('.').pop()?.toLowerCase() || '';
        const FILE_EXTS = new Set([
          'ts','tsx','js','jsx','json','md','mdx','css','scss','less','html','xml',
          'yaml','yml','toml','txt','log','env','lock','sql','db','py','rb','rs',
          'go','java','sh','bash','zsh','conf','cfg','ini','svg','png','jpg','jpeg',
          'gif','ico','woff','woff2','ttf','eot','map','d','mjs','cjs','mts','cts',
          'vue','svelte','astro','wasm','zip','tar','gz','pdf','docx','pptx','xlsx',
        ]);
        if (FILE_EXTS.has(ext)) return null;
      }
      return { kind: 'external' as const, url: normalized };
    }

    return null;
  }, [query]);

  const handleOpenUrl = useCallback(() => {
    if (!detectedUrl) return;

    if (detectedUrl.kind === 'localhost') {
      const { port, path } = detectedUrl;
      const internalUrl = toInternalUrl(port, path);
      const proxied = buildProxyUrl(internalUrl) || internalUrl;
      const tabId = `preview:${port}`;
      openTabAndNavigate({
        id: tabId,
        title: `localhost:${port}`,
        type: 'preview',
        href: `/p/${port}`,
        metadata: enrichPreviewMetadata({
          url: proxied,
          port,
          originalUrl: internalUrl,
          path,
        }),
      });
    } else {
      // External URL — proxy through backend web proxy
      const extUrl = detectedUrl.url;
      const proxyUrl = buildWebProxyUrl(extUrl, subdomainOpts) || extUrl;
      let displayHost: string;
      try { displayHost = new URL(extUrl).hostname; } catch { displayHost = extUrl; }

      openTabAndNavigate({
        id: `preview:web`,
        title: displayHost,
        type: 'preview',
        href: '/p/web',
        metadata: enrichPreviewMetadata({
          url: proxyUrl,
          port: 0,
          originalUrl: extUrl,
          path: '/',
        }),
      });
    }
    close();
  }, [detectedUrl, buildProxyUrl, subdomainOpts, close]);

  const handleToggleSidebar = useCallback(() => {
    sidebarCtx?.toggleSidebar();
    close();
  }, [sidebarCtx, close]);

  const handleOpenSettings = useCallback((tab: SettingsTabId) => {
    close();
    setSettingsTab(tab);
    setSettingsOpen(true);
  }, [close]);

  const handleOpenPlan = useCallback(() => {
    close();
    openNewInstanceModal();
  }, [close, openNewInstanceModal]);

  const handleLogout = useCallback(async () => {
    close();
    const supabase = createClient();
    await supabase.auth.signOut();
    clearUserLocalStorage();
    await clearSessionIDBCache();
    router.push('/auth');
  }, [close, router]);

  const handleSetTheme = useCallback((newTheme: string) => {
    setTheme(newTheme);
    close();
  }, [setTheme, close]);

  const handleCompactSession = useCallback(() => {
    if (!currentSessionId) return;
    close();
    setCompactOpen(true);
  }, [currentSessionId, close]);

  const handleViewChanges = useCallback(() => {
    if (!currentSessionId) return;
    close();
    setDiffOpen(true);
  }, [currentSessionId, close]);

  // ── Registry action dispatcher ──
  const handleOpenProviderModal = useCallback(() => {
    close();
    import('@/stores/provider-modal-store').then(({ useProviderModalStore }) => {
      useProviderModalStore.getState().openProviderModal('connected');
    });
  }, [close]);

  const handleGenerateSSHKey = useCallback(() => {
    close();
    import('@/stores/ssh-dialog-store').then(({ useSSHDialogStore }) => {
      useSSHDialogStore.getState().openSSHDialog();
    });
  }, [close]);

  const handleRestartConfig = useCallback(() => {
    close();
    const serverUrl = useServerStore.getState().getActiveServerUrl();
    authenticatedFetch(`${serverUrl}/kortix/services/system/reload`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'dispose-only' }),
    }).then((res) => {
      if (res.ok) toast.success('Config reloaded');
      else toast.error('Restart failed');
    }).catch(() => toast.error('Restart failed'));
  }, [close]);

  const handleRestartFull = useCallback(() => {
    close();
    const serverUrl = useServerStore.getState().getActiveServerUrl();
    authenticatedFetch(`${serverUrl}/kortix/services/system/reload`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'full' }),
    }).then((res) => {
      if (res.ok) toast.success('Full restart initiated');
      else toast.error('Restart failed');
    }).catch(() => toast.error('Restart failed'));
  }, [close]);

  const actionHandlers: Record<string, () => void> = useMemo(() => ({
    newSession: handleNewSession,
    openTerminal: handleOpenTerminal,
    compactSession: handleCompactSession,
    viewChanges: handleViewChanges,
    toggleSidebar: handleToggleSidebar,
    logout: handleLogout,
    openPlan: handleOpenPlan,
    openProviderModal: handleOpenProviderModal,
    generateSSHKey: handleGenerateSSHKey,
    restartConfig: handleRestartConfig,
    restartFull: handleRestartFull,
  }), [handleNewSession, handleOpenTerminal, handleCompactSession, handleViewChanges, handleToggleSidebar, handleLogout, handleOpenPlan, handleOpenProviderModal, handleGenerateSSHKey, handleRestartConfig, handleRestartFull]);

  const handleRegistryItem = useCallback((item: MenuItemDef) => {
    switch (item.kind) {
      case 'navigate': {
        const href = item.href || '';
        // Customize is a full-screen overlay, not a route — open it in place so
        // the active session/page stays mounted behind it (no tab, no nav).
        const custMatch = href.match(/\/customize(?:\/([^/?#]+))?/);
        if (custMatch) {
          useCustomizeStore
            .getState()
            .openCustomize(parseCustomizeSection(custMatch[1]) ?? undefined);
          close();
          break;
        }
        // New project/account routes use the Next router directly — the project
        // tab bar auto-syncs from the URL. The legacy tabbed shell is bypassed.
        if (href.startsWith('/projects') || href.startsWith('/accounts')) {
          router.push(href);
          close();
          break;
        }
        // Legacy global-shell tabbed navigation (browser, preview, desktop, etc.)
        const tabType = (item.tabType || (href.startsWith('/settings') ? 'settings' : 'page')) as any;
        const tabId = item.tabId || `page:${href}`;
        openTabAndNavigate(
          {
            id: tabId,
            title: item.label || href.split('/').pop() || '',
            type: tabType,
            href,
            ...(item.tabType === 'preview' ? { metadata: { url: '', port: 0, originalUrl: '', path: '/' } } : {}),
          },
          router,
        );
        close();
        break;
      }
      case 'settings':
        handleOpenSettings(item.settingsTab!);
        break;
      case 'theme':
        handleSetTheme(item.themeValue!);
        break;
      case 'action': {
        const handler = actionHandlers[item.actionId!];
        if (handler) handler();
        break;
      }
    }
  }, [router, close, handleOpenSettings, handleSetTheme, actionHandlers]);

  // ── Agent/Model selection handlers ──
  const handleSelectAgent = useCallback((agentName: string) => {
    if (!currentSessionId) return;
    modelStore.setSessionAgentName(currentSessionId, agentName);
    toast.success(`Agent switched to ${agentName}`);
    close();
  }, [currentSessionId, modelStore, close]);

  const handleSelectModel = useCallback((providerID: string, modelID: string) => {
    if (!currentAgent) return;
    modelStore.setSelectedModel(currentAgent.name, { providerID, modelID });
    modelStore.pushRecent({ providerID, modelID });
    const model = allModels.find((m) => m.providerID === providerID && m.modelID === modelID);
    toast.success(`Model switched to ${model?.modelName || modelID}`);
    close();
  }, [currentAgent, modelStore, allModels, close]);

  // Count results for footer
  const totalSearchResults = useMemo(() => {
    if (page === 'agents') return filteredAgents.length;
    if (page === 'models') return visibleModels.length;
    if (page === 'projects') return filteredProjectsList.length;
    if (page === 'accounts') return filteredAccountsList.length;
    if (page === 'sessions') return filteredProjectSessionsList.length;
    if (page === 'messages') return 0; // count is shown inline by MessagesPage
    if (!hasQuery) return 0;
    return (
      filteredNavItems.length +
      rootSessionResults.length +
      rootProjectResults.length +
      sessionActionItems.length
    );
  }, [page, hasQuery, filteredNavItems, rootSessionResults, rootProjectResults, sessionActionItems, filteredAgents, visibleModels, filteredProjectsList, filteredAccountsList, filteredProjectSessionsList]);

  // ── Placeholder text ──
  const placeholder = useMemo(() => {
    if (page === 'agents') return 'Search agents...';
    if (page === 'models') return 'Search models...';
    if (page === 'files') return 'Search files in this project...';
    if (page === 'messages') return 'Search messages...';
    if (page === 'projects') return 'Search projects...';
    if (page === 'accounts') return 'Search accounts...';
    if (page === 'sessions') return 'Search sessions...';
    return 'Search commands, sessions...';
  }, [page]);

  // ── Page title for submenu header ──
  const pageTitle = useMemo(() => {
    if (page === 'agents') return 'Change Agent';
    if (page === 'models') return 'Change Model';
    if (page === 'files') return 'Search Files';
    if (page === 'messages') return 'Jump to Message';
    if (page === 'projects') return 'Switch Project';
    if (page === 'accounts') return 'Switch Account';
    if (page === 'sessions') return 'Open Session';
    return null;
  }, [page]);

  return (
    <>
      <CommandDialog open={open} onOpenChange={setOpen} className="sm:max-w-[680px]">
        {/* Submenu breadcrumb header */}
        {page !== 'root' && (
          <div className="flex items-center gap-2 px-4 pt-3 pb-0.5">
            <button
              type="button"
              onClick={goBack}
              className="group flex items-center gap-1 rounded-md px-1.5 py-0.5 -ml-1.5 text-xs text-muted-foreground/60 hover:text-foreground hover:bg-foreground/[0.04] transition-colors cursor-pointer"
            >
              <ArrowLeft className="h-3 w-3 transition-transform group-hover:-translate-x-0.5" />
              <span>Back</span>
            </button>
            <span className="text-xs text-muted-foreground/25">/</span>
            <span className="text-xs font-medium text-foreground/85 tracking-[-0.005em]">{pageTitle}</span>
          </div>
        )}

        <CommandInput
          ref={inputRef}
          placeholder={placeholder}
          value={query}
          onValueChange={setQuery}
        />

        <CommandList>
          {/* ============================================================ */}
          {/* PAGE: ROOT                                                    */}
          {/* ============================================================ */}
          {page === 'root' && (
            <>
              {/* ── IDLE STATE ── */}
              {!hasQuery && (
                <>
                  <CommandGroup heading="Suggestions" forceMount>
                    {allPaletteItems
                      .filter(
                        (item) =>
                          item.group === 'actions' ||
                          item.group === 'navigation',
                      )
                      .slice(0, 8)
                      .map((item) => {
                        const Icon = item.icon;
                        const isToggleSidebar = item.id === 'toggle-sidebar';
                        const DisplayIcon = isToggleSidebar
                          ? sidebarOpen
                            ? PanelLeftClose
                            : PanelLeftIcon
                          : Icon;
                        const displayLabel = isToggleSidebar
                          ? sidebarOpen
                            ? 'Collapse Sidebar'
                            : 'Expand Sidebar'
                          : item.label;

                        const submenuPage = SUBMENU_PAGE_BY_ID[item.id];
                        return (
                          <CommandItem
                            key={item.id}
                            value={sanitizeCmdkValue(`suggestion ${item.label} ${item.keywords || ''}`)}
                            onSelect={() =>
                              submenuPage ? goToPage(submenuPage) : handleRegistryItem(item)
                            }
                            disabled={item.id === 'new-session' && isCreating}
                          >
                            {item.id === 'new-session' && isCreating ? (
                              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                            ) : (
                              <DisplayIcon className="h-4 w-4" />
                            )}
                            <span className="flex-1">{displayLabel}</span>
                            {item.shortcut && (
                              <CommandShortcut>{item.shortcut}</CommandShortcut>
                            )}
                            {submenuPage && (
                              <ChevronRight className="h-3 w-3 text-muted-foreground/30" />
                            )}
                          </CommandItem>
                        );
                      })}

                    {/* Session actions in idle state */}
                    {currentSessionId && (
                      <>
                        <CommandItem
                          value="suggestion change agent worker switch"
                          onSelect={() => goToPage('agents')}
                        >
                          <Bot className="h-4 w-4" />
                          <span className="flex-1">{tHardcodedUi.raw('componentsCommandPalette.line1209JsxTextChangeAgent')}</span>
                          {currentAgent && (
                            <span className="text-xs text-muted-foreground/40">{currentAgent.name}</span>
                          )}
                          <ChevronRight className="h-3 w-3 text-muted-foreground/30" />
                        </CommandItem>
                        <CommandItem
                          value="suggestion change model llm switch"
                          onSelect={() => goToPage('models')}
                        >
                          <Cpu className="h-4 w-4" />
                          <span className="flex-1">{tHardcodedUi.raw('componentsCommandPalette.line1220JsxTextChangeModel')}</span>
                          {currentModelKey && (
                            <span className="text-xs text-muted-foreground/40 truncate max-w-[160px]">
                              {allModels.find(
                                (m) => m.providerID === currentModelKey.providerID && m.modelID === currentModelKey.modelID,
                              )?.modelName || currentModelKey.modelID}
                            </span>
                          )}
                          <ChevronRight className="h-3 w-3 text-muted-foreground/30" />
                        </CommandItem>
                        <CommandItem
                          value="suggestion jump to message go scroll navigate"
                          onSelect={() => goToPage('messages')}
                        >
                          <MessageCircle className="h-4 w-4" />
                          <span className="flex-1">{tHardcodedUi.raw('componentsCommandPalette.line1235JsxTextJumpToMessage')}</span>
                          <ChevronRight className="h-3 w-3 text-muted-foreground/30" />
                        </CommandItem>
                      </>
                    )}

                    {/* File search entry point — searches the project's git repo */}
                    {projectId && (
                      <CommandItem
                        value="suggestion search files find file grep repo content"
                        onSelect={() => goToPage('files')}
                      >
                        <Search className="h-4 w-4" />
                        <span className="flex-1">{tHardcodedUi.raw('componentsCommandPalette.line1248JsxTextSearchFiles')}</span>
                        <span className="px-1.5 py-0.5 rounded-[5px] bg-foreground/[0.04] border border-border/40 text-xs font-mono text-muted-foreground/55 leading-none">
                          repo
                        </span>
                        <ChevronRight className="h-3 w-3 text-muted-foreground/40" />
                      </CommandItem>
                    )}
                  </CommandGroup>

                  {/* Recent — project sessions when scoped to a project, else
                      recent projects (no legacy global session feed). */}
                  {projectId && recentProjectSessions.length > 0 && (
                    <CommandGroup heading={tHardcodedUi.raw('componentsCommandPalette.line1260JsxAttrHeadingRecentSessions')} forceMount>
                      {recentProjectSessions.map((session) => (
                        <CommandItem
                          key={session.session_id}
                          value={sanitizeCmdkValue(`recent ${sessionName(session)} ${session.session_id}`)}
                          onSelect={() => handleSelectProjectSession(session)}
                        >
                          <MessageCircle className="h-4 w-4 flex-shrink-0" />
                          <span className="truncate flex-1">{sessionName(session)}</span>
                          {session.session_id === params?.sessionId && (
                            <span className="text-xs text-primary/60 font-medium">Current</span>
                          )}
                          <span className="text-xs text-muted-foreground/30 tabular-nums flex-shrink-0">
                            {formatRelativeTime(new Date(session.updated_at).getTime())}
                          </span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  )}

                  {!projectId && recentProjects.length > 0 && (
                    <CommandGroup heading={tHardcodedUi.raw('componentsCommandPalette.line1281JsxAttrHeadingRecentProjects')} forceMount>
                      {recentProjects.map((project) => (
                        <CommandItem
                          key={project.project_id}
                          value={sanitizeCmdkValue(`recent project ${project.name} ${project.project_id}`)}
                          onSelect={() => handleSelectProject(project)}
                        >
                          <FolderGit2 className="h-4 w-4 flex-shrink-0" />
                          <span className="truncate flex-1">{project.name}</span>
                          {(project.last_opened_at || project.updated_at) && (
                            <span className="text-xs text-muted-foreground/30 tabular-nums flex-shrink-0">
                              {formatRelativeTime(
                                new Date(project.last_opened_at || project.updated_at).getTime(),
                              )}
                            </span>
                          )}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  )}
                </>
              )}

              {/* ── SEARCH STATE ── */}
              {hasQuery && (
                <>
                  {/* Session actions (Change Agent / Change Model) */}
                  {hasSessionActionResults && (
                    <CommandGroup heading="Session" forceMount>
                      {sessionActionItems.map((item) => (
                        <CommandItem
                          key={item.id}
                          value={`${item.label} ${item.keywords}`}
                          onSelect={() => goToPage(item.targetPage)}
                        >
                          {item.id === 'change-agent' ? <Bot className="h-4 w-4" /> : item.id === 'jump-to-message' ? <MessageCircle className="h-4 w-4" /> : <Cpu className="h-4 w-4" />}
                          <span className="flex-1">{item.label}</span>
                          <ChevronRight className="h-3 w-3 text-muted-foreground/30" />
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  )}

                  {/* Navigation */}
                  {hasNavResults && (
                    <CommandGroup heading="Navigation" forceMount>
                      {filteredNavItems.map((item) => {
                        const Icon = item.icon;
                        const isToggleSidebar = item.id === 'toggle-sidebar';
                        const SidebarIcon = isToggleSidebar
                          ? (sidebarOpen ? PanelLeftClose : PanelLeftIcon)
                          : Icon;
                        const displayLabel = isToggleSidebar
                          ? (sidebarOpen ? 'Collapse Sidebar' : 'Expand Sidebar')
                          : item.label;
                        const isActiveTheme = item.kind === 'theme' && theme === item.themeValue;
                        const submenuPage = SUBMENU_PAGE_BY_ID[item.id];

                        return (
                        <CommandItem
                          key={item.id}
                          value={sanitizeCmdkValue(item.keywords || `${item.group} ${item.label} ${item.id}`)}
                          onSelect={() =>
                            submenuPage ? goToPage(submenuPage) : handleRegistryItem(item)
                          }
                            disabled={item.id === 'new-session' && isCreating}
                          >
                            {item.id === 'new-session' && isCreating ? (
                              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                            ) : (
                              <SidebarIcon className="h-4 w-4" />
                            )}
                            <span className="flex-1">{displayLabel}</span>
                            {item.shortcut && (
                              <CommandShortcut>
                                {item.shortcut}
                              </CommandShortcut>
                            )}
                            {isActiveTheme && (
                              <span className="text-xs text-primary/60 font-medium">Active</span>
                            )}
                            {submenuPage && (
                              <ChevronRight className="h-3 w-3 text-muted-foreground/30" />
                            )}
                          </CommandItem>
                        );
                      })}
                    </CommandGroup>
                  )}

                  {/* Sessions — project-scoped, current source only */}
                  {hasSessionResults && (
                    <CommandGroup heading="Sessions" forceMount>
                      {rootSessionResults.map((session) => (
                        <CommandItem
                          key={session.session_id}
                          value={sanitizeCmdkValue(`session ${sessionName(session)} ${session.session_id}`)}
                          onSelect={() => handleSelectProjectSession(session)}
                        >
                          <MessageCircle className="h-4 w-4 flex-shrink-0" />
                          <span className="truncate text-sm flex-1">{sessionName(session)}</span>
                          {session.session_id === params?.sessionId && (
                            <Check className="h-3.5 w-3.5 text-primary flex-shrink-0" />
                          )}
                          <span className="text-xs text-muted-foreground/40 tabular-nums flex-shrink-0">
                            {formatRelativeTime(new Date(session.updated_at).getTime())}
                          </span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  )}

                  {/* Projects — surfaced in the global shell where there is no
                      active project to scope sessions to. */}
                  {hasProjectResults && (
                    <CommandGroup heading="Projects" forceMount>
                      {rootProjectResults.map((project) => (
                        <CommandItem
                          key={project.project_id}
                          value={sanitizeCmdkValue(`project ${project.name} ${project.project_id}`)}
                          onSelect={() => handleSelectProject(project)}
                        >
                          <FolderGit2 className="h-4 w-4 flex-shrink-0" />
                          <span className="truncate text-sm flex-1">{project.name}</span>
                          {(project.last_opened_at || project.updated_at) && (
                            <span className="text-xs text-muted-foreground/40 tabular-nums flex-shrink-0">
                              {formatRelativeTime(
                                new Date(project.last_opened_at || project.updated_at).getTime(),
                              )}
                            </span>
                          )}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  )}

                  {/* Open URL — shown when query looks like a URL or port */}
                  {detectedUrl && (
                    <CommandGroup heading={tHardcodedUi.raw('componentsCommandPalette.line1419JsxAttrHeadingOpenURL')} forceMount>
                      <CommandItem
                        value={sanitizeCmdkValue(`open url browser preview ${query.trim()} localhost port`)}
                        onSelect={handleOpenUrl}
                      >
                        <Globe className="h-4 w-4 text-blue-400" />
                        <span className="flex-1 truncate">
                          {detectedUrl.kind === 'localhost'
                            ? `Open localhost:${detectedUrl.port}${detectedUrl.path !== '/' ? detectedUrl.path : ''}`
                            : `Open ${new URL(detectedUrl.url).hostname}`}
                        </span>
                        <span className="text-xs text-muted-foreground/40">browser</span>
                      </CommandItem>
                    </CommandGroup>
                  )}

                  {/* Search files action — searches the project's git repo */}
                  {queryLongEnough && !detectedUrl && projectId && (
                    <CommandGroup heading={tHardcodedUi.raw('componentsCommandPalette.line1437JsxAttrHeadingFileSearch')} forceMount>
                      <CommandItem
                        value={sanitizeCmdkValue(`search files ${query.trim()} repo grep find open`)}
                        onSelect={() => goToPage('files', true)}
                      >
                        <Search className="h-4 w-4" />
                        <span className="flex-1">
                          {tHardcodedUi.raw('componentsCommandPalette.line1444JsxTextSearchFilesFor')}{query.trim()}{tHardcodedUi.raw('componentsCommandPalette.line1444JsxTextText')}</span>
                        <span className="px-1.5 py-0.5 rounded-[5px] bg-foreground/[0.04] border border-border/40 text-xs font-mono text-muted-foreground/55 leading-none">
                          repo
                        </span>
                        <ChevronRight className="h-3 w-3 text-muted-foreground/40" />
                      </CommandItem>
                    </CommandGroup>
                  )}

                  {/* No results */}
                  {showNoResults && (
                    <div className="flex flex-col items-center gap-2 py-12" cmdk-empty="">
                      <div className="flex items-center justify-center h-10 w-10 rounded-full bg-muted/30">
                        <Search className="h-4 w-4 text-muted-foreground/30" />
                      </div>
                      <div className="text-center">
                        <span className="text-sm text-muted-foreground/60">
                          {tHardcodedUi.raw('componentsCommandPalette.line1462JsxTextNoResultsFor')}{query.trim()}{tHardcodedUi.raw('componentsCommandPalette.line1462JsxTextText')}</span>
                        <p className="text-xs text-muted-foreground/30 mt-1">
                          {tHardcodedUi.raw('componentsCommandPalette.line1465JsxTextTrySearchFilesOrADifferentTerm')}</p>
                      </div>
                    </div>
                  )}
                </>
              )}
            </>
          )}

          {/* ============================================================ */}
          {/* PAGE: AGENTS                                                  */}
          {/* ============================================================ */}
          {page === 'agents' && (
            <>
              {primaryAgents.length > 0 && (
                <CommandGroup heading="Agents" forceMount>
                  {primaryAgents.map((agent) => {
                    const isActive = currentAgent?.name === agent.name;
                    return (
                      <CommandItem
                        key={agent.name}
                        value={sanitizeCmdkValue(`agent ${agent.name} ${agent.description || ''}`)}
                        onSelect={() => handleSelectAgent(agent.name)}
                      >
                        <Bot className="h-4 w-4" />
                        <div className="flex flex-col overflow-hidden flex-1 min-w-0">
                          <span className="truncate text-sm font-medium">{agent.name}</span>
                          {agent.description && (
                            <span className="text-xs text-muted-foreground/50 truncate">
                              {agent.description}
                            </span>
                          )}
                        </div>
                        {isActive && (
                          <Check className="h-3.5 w-3.5 text-primary flex-shrink-0" />
                        )}
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              )}

              {subAgents.length > 0 && (
                <CommandGroup heading="Sub-agents" forceMount>
                  {subAgents.map((agent) => {
                    const isActive = currentAgent?.name === agent.name;
                    return (
                      <CommandItem
                        key={agent.name}
                        value={sanitizeCmdkValue(`subagent ${agent.name} ${agent.description || ''}`)}
                        onSelect={() => handleSelectAgent(agent.name)}
                      >
                        <Bot className="h-4 w-4 text-muted-foreground/50" />
                        <div className="flex flex-col overflow-hidden flex-1 min-w-0">
                          <span className="truncate text-sm">{agent.name}</span>
                          {agent.description && (
                            <span className="text-xs text-muted-foreground/50 truncate">
                              {agent.description}
                            </span>
                          )}
                        </div>
                        {isActive && (
                          <Check className="h-3.5 w-3.5 text-primary flex-shrink-0" />
                        )}
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              )}

              {filteredAgents.length === 0 && (
                <div className="flex flex-col items-center gap-2 py-12" cmdk-empty="">
                  <Bot className="h-5 w-5 text-muted-foreground/30" />
                  <span className="text-sm text-muted-foreground/60">
                    {query ? `No agents matching "${query}"` : 'No agents available'}
                  </span>
                </div>
              )}
            </>
          )}

          {/* ============================================================ */}
          {/* PAGE: MODELS                                                  */}
          {/* ============================================================ */}
          {page === 'models' && (
            <>
              {groupedModels.map((group) => (
                <CommandGroup
                  key={group.providerID}
                  heading={
                    <span className="inline-flex items-center gap-1.5">
                      <ProviderLogo providerID={group.providerID} size="small" />
                      {group.providerName}
                    </span>
                  }
                  forceMount
                >
                  {group.models.map((model) => {
                    const isActive =
                      currentModelKey?.providerID === model.providerID &&
                      currentModelKey?.modelID === model.modelID;
                    return (
                      <CommandItem
                        key={`${model.providerID}:${model.modelID}`}
                        value={sanitizeCmdkValue(`model ${model.providerName} ${model.modelName} ${model.modelID}`)}
                        onSelect={() => handleSelectModel(model.providerID, model.modelID)}
                      >
                        <div className="flex flex-col overflow-hidden flex-1 min-w-0">
                          <span className="truncate text-sm">{model.modelName}</span>
                          <span className="text-xs text-muted-foreground/40 font-mono truncate">
                            {model.modelID}
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5 flex-shrink-0">
                          {model.capabilities?.reasoning && (
                            <span className="px-1.5 py-0.5 rounded text-xs font-medium leading-none bg-blue-500/10 text-blue-600 dark:text-blue-400">
                              reasoning
                            </span>
                          )}
                          {model.capabilities?.vision && (
                            <span className="px-1.5 py-0.5 rounded text-xs font-medium leading-none bg-purple-500/10 text-purple-600 dark:text-purple-400">
                              vision
                            </span>
                          )}
                          {isActive && (
                            <Check className="h-3.5 w-3.5 text-primary" />
                          )}
                        </div>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              ))}

              {visibleModels.length === 0 && (
                <div className="flex flex-col items-center gap-2 py-12" cmdk-empty="">
                  <Cpu className="h-5 w-5 text-muted-foreground/30" />
                  <span className="text-sm text-muted-foreground/60">
                    {query ? `No models matching "${query}"` : 'No models available'}
                  </span>
                </div>
              )}
            </>
          )}

          {/* ============================================================ */}
          {/* PAGE: FILES                                                   */}
          {/* ============================================================ */}
          {page === 'files' && projectId && (
            <FileSearchPage projectId={projectId} query={query} onSelect={handleSelectFile} />
          )}

          {/* ============================================================ */}
          {/* PAGE: PROJECTS                                                */}
          {/* ============================================================ */}
          {page === 'projects' && (
            filteredProjectsList.length > 0 ? (
              <CommandGroup heading={`Projects (${filteredProjectsList.length})`} forceMount>
                {filteredProjectsList.map((project) => (
                  <CommandItem
                    key={project.project_id}
                    value={sanitizeCmdkValue(`project ${project.name} ${project.project_id}`)}
                    onSelect={() => handleSelectProject(project)}
                  >
                    <FolderGit2 className="h-4 w-4 shrink-0 text-muted-foreground/70" />
                    <span className="flex-1 truncate">{project.name}</span>
                    {project.project_id === params?.id && (
                      <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : (
              <div className="flex flex-col items-center gap-2 py-12" cmdk-empty="">
                <FolderGit2 className="h-5 w-5 text-muted-foreground/30" />
                <span className="text-sm text-muted-foreground/60">
                  {query ? `No projects matching "${query}"` : 'No projects yet'}
                </span>
              </div>
            )
          )}

          {/* ============================================================ */}
          {/* PAGE: ACCOUNTS                                                */}
          {/* ============================================================ */}
          {page === 'accounts' && (
            filteredAccountsList.length > 0 ? (
              <CommandGroup heading={`Accounts (${filteredAccountsList.length})`} forceMount>
                {filteredAccountsList.map((account) => {
                  const label = account.name || 'Account';
                  return (
                    <CommandItem
                      key={account.account_id}
                      value={sanitizeCmdkValue(`account ${label} ${account.account_id}`)}
                      onSelect={() => handleSelectAccount(account)}
                    >
                      <Users className="h-4 w-4 shrink-0 text-muted-foreground/70" />
                      <span className="flex-1 truncate">{label}</span>
                      {account.account_id === activeAccountId && (
                        <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
                      )}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ) : (
              <div className="flex flex-col items-center gap-2 py-12" cmdk-empty="">
                <Users className="h-5 w-5 text-muted-foreground/30" />
                <span className="text-sm text-muted-foreground/60">
                  {query ? `No accounts matching "${query}"` : 'No accounts'}
                </span>
              </div>
            )
          )}

          {/* ============================================================ */}
          {/* PAGE: SESSIONS (project)                                      */}
          {/* ============================================================ */}
          {page === 'sessions' && (
            filteredProjectSessionsList.length > 0 ? (
              <CommandGroup heading={`Sessions (${filteredProjectSessionsList.length})`} forceMount>
                {filteredProjectSessionsList.map((session) => (
                  <CommandItem
                    key={session.session_id}
                    value={sanitizeCmdkValue(`session ${sessionName(session)} ${session.session_id}`)}
                    onSelect={() => handleSelectProjectSession(session)}
                  >
                    <MessageCircle className="h-4 w-4 shrink-0 text-muted-foreground/70" />
                    <span className="flex-1 truncate">{sessionName(session)}</span>
                    <span className="text-xs text-muted-foreground/30 tabular-nums shrink-0">
                      {formatRelativeTime(new Date(session.updated_at).getTime())}
                    </span>
                    {session.session_id === params?.sessionId && (
                      <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : (
              <div className="flex flex-col items-center gap-2 py-12" cmdk-empty="">
                <MessageCircle className="h-5 w-5 text-muted-foreground/30" />
                <span className="text-sm text-muted-foreground/60">
                  {query ? `No sessions matching "${query}"` : 'No sessions yet'}
                </span>
              </div>
            )
          )}

          {/* ============================================================ */}
          {/* PAGE: MESSAGES                                                */}
          {/* ============================================================ */}
          {page === 'messages' && currentSessionId && (
            <MessagesPage sessionId={currentSessionId} query={query} onSelect={handleJumpToMessage} />
          )}
        </CommandList>

        {/* ── Footer ── */}
        <CommandFooter>
          <div className="flex items-center gap-1">
            <ArrowUp className="h-3 w-3" />
            <ArrowDown className="h-3 w-3" />
            <span>navigate</span>
          </div>
          <div className="flex items-center gap-1">
            <CornerDownLeft className="h-3 w-3" />
            <span>select</span>
          </div>
          {page !== 'root' && (
            <div className="flex items-center gap-1">
              <CommandKbd>⌫</CommandKbd>
              <span>back</span>
            </div>
          )}
          {page === 'files' && (
            <div className="flex items-center gap-1">
              <CommandKbd>{tHardcodedUi.raw('componentsCommandPalette.line1744JsxTextText')}</CommandKbd>
              <span>{tHardcodedUi.raw('componentsCommandPalette.line1745JsxTextContentSearch')}</span>
            </div>
          )}
          <div className="flex items-center gap-1">
            <CommandKbd>esc</CommandKbd>
            <span>close</span>
          </div>
          {totalSearchResults > 0 && (
            <span className="ml-auto tabular-nums">
              {totalSearchResults} result{totalSearchResults !== 1 ? 's' : ''}
            </span>
          )}
        </CommandFooter>
      </CommandDialog>

      {currentSessionId && (
        <>
          <CompactDialog
            sessionId={currentSessionId}
            open={compactOpen}
            onOpenChange={setCompactOpen}
          />
          <DiffDialog
            sessionId={currentSessionId}
            open={diffOpen}
            onOpenChange={setDiffOpen}
          />
        </>
      )}

      <UserSettingsModal
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        defaultTab={settingsTab}
      />

    </>
  );
}

'use client';

import { SessionSharedIcon } from '@/components/projects/session-shared-icon';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import {
  CommandDialog,
  CommandFooter,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@/components/ui/command';
import Loading from '@/components/ui/loading';
import { SidebarContext } from '@/components/ui/sidebar';
import { errorToast, successToast } from '@/components/ui/toast';
import { buildAgentGitReconciliationPrompt } from '@/features/session/agent-git-reconciliation';
import { openSessionQuickView } from '@/features/session/open-session-quick-view';
import { LEGACY_PALETTE_HIDDEN } from '@/features/workspace/command-palette-visibility';
import {
  consumePendingCommandPalette,
  OPEN_COMMAND_PALETTE_EVENT,
} from '@/features/workspace/open-command-palette';
import {
  sessionLastActivityAt,
  sortSessionsByLastActivity,
} from '@/features/workspace/project-sidebar/project-session-list-helpers';
import {
  PALETTE_NO_PROJECT_DEFAULT_TAB,
  filterSettingsPaletteGroups,
  settingsPaletteGroups,
  settingsPaletteSearchText,
} from '@/features/workspace/settings-palette-items';
import {
  DEFAULT_SETTINGS_TAB,
  resolveSettingsOverlayHref,
  type SettingsTab,
} from '@/features/workspace/settings/settings-tabs';
import { useSettingsAccountId } from '@/features/workspace/settings/use-settings-account-id';
import { useNewProjectSession } from '@/hooks/projects/use-new-project-session';
import { type MenuItemDef, type SettingsTabId, getItemsForSurface } from '@/lib/menu-registry';
import { PROJECT_LANDING_PATH } from '@/lib/onboarding/landing-destination';
import { useProjectFeatureFlags } from '@/lib/use-project-feature-flags';
import { cn } from '@/lib/utils';
import { useChatSendStore } from '@/stores/chat-send-store';
import { useCurrentAccountStore } from '@/stores/current-account-store';
import { useProjectSessionTabsStore } from '@/stores/project-session-tabs-store';
import { useSettingsPanelStore } from '@/stores/settings-panel-store';
import {
  type KortixAccount,
  type KortixProject,
  type ProjectSession,
  featureFlags,
  getProjectDetail,
  listAccounts,
  listProjectSessions,
  listProjectsForAccount,
  normalizeAppPathname,
  systemReload,
} from '@kortix/sdk';
import { contract, qk, useRuntimeAgents, useRuntimeProviders } from '@kortix/sdk/react';
import {
  ArrowDownIcon as ArrowDown,
  ArrowUpIcon as ArrowUp,
  RobotIcon as Bot,
  CheckIcon as Check,
  CaretRightIcon as ChevronRight,
  ArrowElbowDownLeftIcon as CornerDownLeft,
  CpuIcon as Cpu,
  FileTextIcon as FileText,
  GitBranchIcon as FolderGit2,
  GlobeIcon as Globe,
  HashIcon as Hash,
  ChatCircleIcon as MessageCircle,
  SidebarSimpleIcon as PanelLeftClose,
  SidebarSimpleIcon as PanelLeftIcon,
  MagnifyingGlassIcon as Search,
  MinusIcon as Minus,
  TextAlignLeftIcon as TextAlignLeft,
} from '@phosphor-icons/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useParams, usePathname, useRouter } from 'next/navigation';
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { FadedScrollArea } from '@/components/ui/faded-scroll-area';
import { Kbd } from '@/components/ui/kbd';
import { TextShimmer } from '@/components/ui/text-shimmer';
import { useWorkspaceSearch } from '@/features/files';
import { MODEL_SELECTOR_PROVIDER_IDS, ProviderLogo } from '@/features/providers/provider-branding';
import { DiffDialog } from '@/features/session/diff-dialog';
import { CompactModal } from '@/features/session/header/compact-modal';
import { pickerGroupId, pickerGroupLabel } from '@/features/session/model-grouping';
import { flattenModels } from '@/features/session/session-chat-input';
import { useSandboxProxy } from '@/hooks/use-sandbox-proxy';
import { isBillingEnabled } from '@/lib/config';
import { createClient } from '@/lib/supabase/client';
import { track } from '@/lib/track';
import { clearUserLocalStorage } from '@/lib/utils/clear-local-storage';
import { stripKortixSystemTags } from '@/lib/utils/kortix-system-tags';
import {
  buildWebProxyUrl,
  normalizeExternalInput,
  parseLocalhostUrl,
  toInternalUrl,
} from '@/lib/utils/sandbox-url';
import { enrichPreviewMetadata } from '@/lib/utils/session-context';
import { stripHtmlTags } from '@/lib/utils/strip-html-tags';
import { DEFAULT_WALLPAPER_ID } from '@/lib/wallpapers';
import { useMessageJumpStore } from '@/stores/message-jump-store';
import { openTabAndNavigate } from '@/stores/tab-store';
import { useUpgradeDialogStore } from '@/stores/upgrade-dialog-store';
import {
  useUserPreferencesStore,
  type ConversationDensity,
} from '@/stores/user-preferences-store';
import { type TextPart, groupMessagesIntoTurns, isTextPart } from '@/ui';
import { clearSessionIDBCache } from '@kortix/sdk/idb-sync-cache';
import {
  useCreatePty,
  useCreateRuntimeSession,
  useModelStore,
  useRuntimeMessages,
} from '@kortix/sdk/react';
import { capitalizeWords, chalkColors, formatRelativeTime } from '@kortix/shared';
import { UsersIcon as UsersSolid } from '@phosphor-icons/react';
import { useTheme } from 'next-themes';

type PalettePage =
  | 'root'
  | 'agents'
  | 'models'
  | 'messages'
  | 'projects'
  | 'accounts'
  | 'sessions'
  | 'files'
  | 'density';

function sanitizeCmdkValue(value: string): string {
  return value
    .replace(/["'\\[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The searchable text of a registry-backed palette row — and, because cmdk
 * scores a row by its `value` and nothing else, its cmdk `value` too.
 *
 * **Label plus curated keywords. Never `id`, never `group`.** Both used to be
 * in here. `id` made `nav-accounts`, `proj-secrets`, `pref-general` and
 * `account-tokens` searchable, so "nav", "proj", "pref" and "account" each
 * returned a whole family of rows by a string the user has never seen. `group`
 * made every row in the `account` group answer "account" whatever it meant.
 * Neither is user-visible, so neither can be what the user meant.
 *
 * **This is also the row's cmdk selection identity**, which cmdk requires to
 * be unique — two rows sharing a `value` are both marked `aria-selected` and
 * Enter always fires the first one. cmdk 0.2.1 (the installed version, checked
 * against `node_modules/cmdk/dist/index.d.ts`) has no separate `keywords` prop
 * to move the search text onto, and `CommandDialog` in `components/ui/command`
 * forwards neither `filter` nor `shouldFilter`, so the value is the only lever.
 * Uniqueness therefore rests on the curated text itself, which is safe because
 * a collision means two rows with the SAME label and the SAME keywords — rows
 * a user could not tell apart either. `command-palette-search.test.ts` asserts
 * it for every row the palette can render at once.
 */
export function buildPaletteSearchText(item: { label: string; keywords?: string }): string {
  return sanitizeCmdkValue(`${item.label} ${item.keywords ?? ''}`);
}

/**
 * Legacy `SettingsTabId` (menu-registry's vocabulary) -> new `SettingsTab`
 * (settings-tabs.ts), for the command-palette items whose `kind` is
 * `'settings'`. Task 10 retired the legacy user-settings modal these items
 * used to open directly, in favor of `useSettingsPanelStore` — the same
 * overlay the `'navigate'` branch below already opens via
 * `resolveSettingsOverlayHref`.
 *
 * `tokens` -> `api-keys` and `transactions` -> `usage` mirror
 * `RENAMED_TABS` in `settings-tabs.ts` (same rename, same source
 * vocabulary). `appearance`, `sounds`, and `shortcuts` all merged into the
 * new `preferences` tab — `tabs/preferences-tab.tsx` already hosts all
 * three (wallpaper/theme, sound-pack controls, and a full "Keyboard
 * shortcuts" section with the modifier picker and shortcut list).
 *
 * NOTE: no palette entry uses `kind: 'settings'` any more — every settings
 * destination is now derived from the rail (`settings-palette-items.ts`), so
 * `handleOpenSettings` below is unreachable from the current registry. The
 * map and the branch stay because `MenuItemDef.kind` still admits
 * `'settings'` and the `userMenu` surface still declares entries with it; if
 * one is re-added to `showIn: ['commandPalette']` it must open through
 * `openSettingsTab`, not through a raw `openSettings` call.
 *
 * `referrals` is deliberately absent: there is no `referrals` member of
 * `SettingsTab`, and the only live referral surface (`ReferralModal`) mounts
 * inside `UserMenu` -> `AppHeader`, i.e. only on `/accounts/**`. Its registry
 * entry was removed rather than mapped — see `menu-registry.ts`.
 */
export const LEGACY_SETTINGS_TAB_MAP: Partial<Record<SettingsTabId, SettingsTab>> = {
  // `billing`, `tokens` and `transactions` are gone. They mapped onto the
  // overlay's `billing` / `api-keys` / `usage` tabs, and all three tabs left
  // the overlay for `/accounts/[id]`. There is no `SettingsTab` to map them
  // to any more, and mapping them to a survivor would open Settings on an
  // unrelated pane — so the registry rows that spoke those ids became plain
  // `kind: 'navigate'` rows pointed straight at the account page instead
  // (`account-billing`, `account-tokens`, `account-usage` in
  // `lib/menu-registry.ts`).
  appearance: 'preferences',
  sounds: 'preferences',
  shortcuts: 'preferences',
};

const SUBMENU_PAGE_BY_ID: Record<string, PalettePage> = {
  'nav-projects': 'projects',
  'nav-accounts': 'accounts',
  'proj-sessions': 'sessions',
  'conversation-density': 'density',
};

/**
 * The density page's two rows. Same shape and copy as `VERBOSITY_OPTIONS`
 * in `tabs/preferences-tab.tsx` — the palette page and the Preferences cards
 * are the same choice through two doors, so the words must not drift.
 */
const DENSITY_PAGE_OPTIONS: {
  id: ConversationDensity;
  label: string;
  description: string;
}[] = [
  {
    id: 'normal',
    label: 'Normal',
    description: 'Steps and thinking stream live while Kortix works',
  },
  {
    id: 'minimal',
    label: 'Minimal',
    description: 'One status line until you expand it',
  },
];

function FileSearchPage({
  query,
  onSelect,
}: {
  query: string;
  onSelect: (filePath: string, lineNumber?: number) => void;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const { results, textResults, isLoading, isContentSearch, effectiveQuery, hasResults } =
    useWorkspaceSearch(query, { minQueryLength: 1, maxResults: 50, maxTextResults: 50 });

  const fileResults = useMemo(() => results.filter((r) => !r.isDir), [results]);

  if (!effectiveQuery) {
    return (
      <div className="flex flex-col items-center gap-3 py-12">
        <div className="space-y-1 text-center">
          <p className="text-muted-foreground/60 text-sm">
            {tHardcodedUi.raw(
              'componentsCommandPalette.line183JsxTextSearchFilesInThisProjectSRepo',
            )}
          </p>
          <p className="text-muted-foreground/30 text-xs">
            {tHardcodedUi.raw('componentsCommandPalette.line185JsxTextPrefixWith')}{' '}
            <kbd className="bg-muted rounded px-1 py-0.5 font-mono text-xs">
              {tHardcodedUi.raw('componentsCommandPalette.line186JsxTextText')}
            </kbd>{' '}
            {tHardcodedUi.raw('componentsCommandPalette.line186JsxTextToSearchFileContents')}
          </p>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center gap-2 py-10">
        <TextShimmer>
          {isContentSearch ? 'Searching file contents…' : 'Searching files…'}
        </TextShimmer>
      </div>
    );
  }

  if (!hasResults) {
    return (
      <div className="flex flex-col items-center gap-2 py-12" cmdk-empty="">
        <div className="bg-popover inline-flex size-8 shrink-0 items-center justify-center rounded-sm border font-semibold">
          <Search className="text-muted-foreground size-4" />
        </div>
        <span className="text-muted-foreground text-sm">
          No {isContentSearch ? 'content matches' : 'files'}{' '}
          {tHardcodedUi.raw('componentsCommandPalette.line213JsxTextFor')}
          {effectiveQuery}
          {tHardcodedUi.raw('componentsCommandPalette.line213JsxTextText')}
        </span>
      </div>
    );
  }

  if (isContentSearch) {
    const grouped = new Map<string, typeof textResults>();
    for (const r of textResults) {
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
                <FileText className="size-3 shrink-0" />
                <span className="text-foreground">{filePath}</span>
              </span>
            }
            forceMount
          >
            {matches.map((match) => (
              <CommandItem
                key={`${filePath}:${match.line_number}:${match.lines || ''}`}
                value={sanitizeCmdkValue(`content ${filePath} ${match.lines} ${match.line_number}`)}
                onSelect={() => onSelect(filePath, match.line_number)}
              >
                <Hash className="text-muted-foreground/40 h-3.5 w-3.5 shrink-0" />
                <span className="text-muted-foreground w-8 shrink-0 text-right text-xs tabular-nums">
                  {match.line_number}
                </span>
                <span className="text-muted-foreground/60 flex-1 truncate font-mono text-sm">
                  {(match.lines || '').trim()}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </>
    );
  }

  return (
    <CommandGroup heading="Files" forceMount>
      {fileResults.map((item) => (
        <CommandItem
          key={item.path}
          value={sanitizeCmdkValue(`file ${item.name} ${item.path}`)}
          onSelect={() => onSelect(item.path)}
        >
          <FileText className="text-muted-foreground size-4 shrink-0" />
          <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
            <span className="shrink-0 text-sm font-medium">{item.name}</span>
            <span className="text-muted-foreground/35 min-w-0 flex-1 truncate font-mono text-xs">
              {item.path}
            </span>
          </div>
        </CommandItem>
      ))}
    </CommandGroup>
  );
}

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
  const { data: messages, isLoading } = useRuntimeMessages(sessionId);

  const turns = useMemo(() => (messages ? groupMessagesIntoTurns(messages) : []), [messages]);

  const items = useMemo(() => {
    const result: { id: string; text: string }[] = [];
    for (const turn of turns) {
      const textParts = turn.userMessage.parts.filter(isTextPart) as TextPart[];
      const raw = textParts.map((p) => p.text).join(' ');
      const stripped = stripHtmlTags(stripKortixSystemTags(raw)).trim();
      if (stripped.length > 0) {
        result.push({ id: turn.userMessage.info.id, text: stripped });
      }
    }
    return result;
  }, [turns]);

  const filtered = useMemo(() => {
    if (!query.trim()) return items;
    const q = query.trim().toLowerCase();
    return items.filter((item) => (item.text || '').toLowerCase().includes(q));
  }, [items, query]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center gap-2 py-10">
        <TextShimmer>
          {tHardcodedUi.raw('componentsCommandPalette.line328JsxTextLoadingMessages')}
        </TextShimmer>
      </div>
    );
  }

  if (filtered.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-12">
        <div className="bg-muted/30 flex h-10 w-10 items-center justify-center rounded-full">
          <MessageCircle className="text-muted-foreground/30 size-4" />
        </div>
        <span className="text-muted-foreground/60 text-sm">
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
          <MessageCircle className="text-muted-foreground/40 h-3.5 w-3.5 shrink-0" />
          <span className="text-muted-foreground/50 w-6 shrink-0 text-right text-xs tabular-nums">
            #{index + 1}
          </span>
          <span className="flex-1 truncate text-sm">
            {item.text.length > 80 ? `${item.text.slice(0, 80)}...` : item.text}
          </span>
        </CommandItem>
      ))}
    </CommandGroup>
  );
}

export function CommandPalette() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState<PalettePage>('root');
  const [isCreating, setIsCreating] = useState(false);
  const [compactOpen, setCompactOpen] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);
  const [backScale, setBackScale] = useState(false);
  const backScaleTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reopenPaletteRef = useRef(false);
  const openUpgradeDialog = useUpgradeDialogStore((s) => s.openUpgradeDialog);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const rawPathname = usePathname();
  const pathname = normalizeAppPathname(rawPathname);
  const params = useParams<{ id?: string; sessionId?: string }>();
  const queryClient = useQueryClient();
  const openProjectTab = useProjectSessionTabsStore((s) => s.openTab);
  const projectId = rawPathname?.startsWith('/projects/') ? (params?.id ?? null) : null;
  const currentSessionId = useMemo(() => {
    if (params?.sessionId) return params.sessionId;
    const match = pathname?.match(/^\/sessions\/([^/]+)/);
    return match ? match[1] : null;
  }, [params?.sessionId, pathname]);
  const sidebarCtx = useContext(SidebarContext);
  const sidebarOpen = sidebarCtx?.open ?? false;
  const { proxyUrl: buildProxyUrl, subdomainOpts } = useSandboxProxy();
  const createSession = useCreateRuntimeSession();
  const createPty = useCreatePty();
  const { theme, setTheme } = useTheme();
  const activeWallpaperId = useUserPreferencesStore(
    (s) => s.preferences.wallpaperId ?? DEFAULT_WALLPAPER_ID,
  );
  const panelMode = useUserPreferencesStore((s) => s.preferences.panelMode ?? 'easy');
  const conversationDensity = useUserPreferencesStore(
    (s) => s.preferences.conversationDensity ?? 'normal',
  );
  const billingEnabled = isBillingEnabled();

  const { data: agents } = useRuntimeAgents();
  const { data: providers } = useRuntimeProviders();

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
    queryKey: qk.projects.list(activeAccountId ?? undefined),
    queryFn: () => listProjectsForAccount(activeAccountId || undefined),
    enabled: open && !!activeAccountId,
    ...contract('inventory'),
  });
  const { data: projectSessionsList } = useQuery({
    queryKey: qk.project.sessions(projectId ?? ''),
    queryFn: () => listProjectSessions(projectId!),
    enabled: open && !!projectId,
    ...contract('inventory'),
  });
  // Same query key every other project surface fetches (page.tsx,
  // project-shell.tsx) — dedupes against that cache entry. Resolves the
  // account the "Invite members" command lands on, via the same fallback
  // `project-shell.tsx` uses for its account-scoped tabs.
  const { data: paletteProjectDetail } = useQuery({
    queryKey: qk.project.detail(projectId ?? ''),
    queryFn: () => getProjectDetail(projectId!),
    enabled: open && !!projectId,
    ...contract('config'),
  });
  const inviteMembersAccountId = useSettingsAccountId(paletteProjectDetail?.project?.account_id);
  const sendToSession = useChatSendStore((state) => state.sendToSession);
  const currentProjectSession = projectSessionsList?.find(
    (session) => session.session_id === currentSessionId,
  );

  // The registry's `requiresFlag` gate. One primitive (`useFeatureFlag`, via
  // `useProjectFeatureFlags`) decides for every surface, so a palette entry can
  // never survive a flag its rail item does not. Fail-closed: unresolved detail
  // ⇒ every flag reads false.
  //
  // `llm_gateway` used to resolve to AVAILABILITY here while the Customize
  // panel rendered nothing unless it was ENABLED — a palette entry that opened
  // a blank pane. It now follows enablement like every other flag.
  // `projectFlags`, not `featureFlags` — the module-scope `featureFlags` import
  // above is the DEPLOYMENT flag set (`@kortix/sdk` featureFlags, build-time
  // capabilities like `enableProjects`), a different concept from the
  // per-project feature flags this gates on.
  const { flags: projectFlags } = useProjectFeatureFlags(open ? projectId : null);

  const allModels = useMemo(() => flattenModels(providers), [providers]);
  // Only for the persisted selection state (session agent, per-agent model,
  // recents) — model visibility is the server's `enabled` flag on each model,
  // never a store heuristic.
  const modelStore = useModelStore(allModels);

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

  const triggerBackScale = useCallback(() => {
    setBackScale(true);
    if (backScaleTimeout.current) clearTimeout(backScaleTimeout.current);
    backScaleTimeout.current = setTimeout(() => setBackScale(false), 130);
  }, []);

  const goToPage = useCallback(
    (p: PalettePage, preserveQuery?: boolean) => {
      setPage(p);
      if (!preserveQuery) setQuery('');
      triggerBackScale();
    },
    [triggerBackScale],
  );

  const goBack = useCallback(() => {
    setPage('root');
    setQuery('');
    triggerBackScale();
  }, [triggerBackScale]);

  useEffect(() => {
    return () => {
      if (backScaleTimeout.current) clearTimeout(backScaleTimeout.current);
    };
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
      errorToast('Failed to open terminal');
    }
    close();
  }, [createPty, close]);

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

  useEffect(() => {
    if (!open) {
      setQuery('');
      setPage('root');
    }
  }, [open]);

  useEffect(() => {
    const openFileSearch = () => {
      setQuery('');
      setPage('files');
      setOpen(true);
    };
    window.addEventListener('kortix:open-file-search', openFileSearch);
    return () => window.removeEventListener('kortix:open-file-search', openFileSearch);
  }, []);

  // Same door as ⌘K, for surfaces that have a button instead of a keystroke
  // (the sidebar's search control). Opens rather than toggles: a click on a
  // control you can only see while the palette is closed always means "open".
  useEffect(() => {
    const openPalette = () => {
      consumePendingCommandPalette();
      setQuery('');
      setPage('root');
      setOpen(true);
    };
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, openPalette);
    // This component is lazily mounted, so a click can land before the
    // listener above exists. Anything requested in that window is replayed
    // here instead of being silently dropped.
    if (consumePendingCommandPalette()) openPalette();
    return () => window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, openPalette);
  }, []);

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

  const fuzzyMatch = useCallback((text: string, q: string): boolean => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const haystack = text.toLowerCase();
    return words.every((w) => haystack.includes(w));
  }, []);

  const hasQuery = query.trim().length > 0;
  const queryLongEnough = query.trim().length >= 2;
  const allPaletteItems = useMemo(() => {
    const result: MenuItemDef[] = [];
    for (const item of getItemsForSurface('commandPalette')) {
      if (LEGACY_PALETTE_HIDDEN.has(item.id)) continue;
      if (item.id === 'toggle-sidebar' && !sidebarCtx) continue;
      if (item.requiresBilling && !billingEnabled) continue;
      if (item.requiresSession && !currentSessionId) continue;
      if (item.requiresProject && !projectId) continue;
      if (item.requiresFlag && !projectFlags[item.requiresFlag]) continue;
      // Token substitution. An href that still holds an UNRESOLVED token after
      // this is dropped, not offered: navigating to a literal
      // `/accounts/{accountId}?tab=billing` is a 404, and offering a row that
      // cannot go anywhere is worse than not offering it. `{projectId}` rows
      // already declare `requiresProject: true` and are filtered above;
      // `{accountId}` rows are filtered here, off the token itself, so a new
      // account-scoped row can never ship without the guard.
      let href = item.href;
      if (href?.includes('{projectId}')) {
        if (!projectId) continue;
        href = href.replaceAll('{projectId}', projectId);
      }
      if (href?.includes('{accountId}')) {
        if (!selectedAccountId) continue;
        href = href.replaceAll('{accountId}', selectedAccountId);
      }
      result.push(href === item.href ? item : { ...item, href });
    }
    return result;
  }, [
    billingEnabled,
    currentSessionId,
    projectId,
    selectedAccountId,
    sidebarCtx,
    projectFlags,
  ]);

  const filteredNavItems = useMemo(() => {
    if (!hasQuery) return allPaletteItems;
    const q = query.trim().toLowerCase();
    const words = q.split(/\s+/).filter(Boolean);
    return allPaletteItems.filter((item) => {
      // Exactly the string that becomes the cmdk `value` below, so the two
      // filters in play read the same text.
      //
      // THIS FILTER DECIDES WHAT IS VISIBLE, not cmdk's. Every CommandGroup in
      // this file passes `forceMount`, and cmdk 0.2.1 propagates a group's
      // `forceMount` to its items through the group context
      // (`g = props.forceMount ?? groupContext.forceMount` in
      // `cmdk/dist/index.mjs`), so cmdk's own scorer never removes one of
      // these rows — it only RANKS them, by scoring the same `value`. That is
      // why a stale keyword here is a wrong ANSWER rather than a wrong order,
      // and why the two can never disagree about which rows exist.
      //
      // They do still disagree about the query: this is a per-word substring
      // test, cmdk's is an ordered-subsequence score. "session terminal" keeps
      // Open Terminal here and scores 0 in cmdk, which sorts it last instead
      // of dropping it. Do NOT remove `forceMount` from a group without
      // replacing this filter — that is what turns the disagreement into
      // rows vanishing under a heading that is still rendered.
      const haystack = buildPaletteSearchText(item).toLowerCase();
      return words.every((w) => haystack.includes(w));
    });
  }, [allPaletteItems, hasQuery, query]);

  // No `flags` argument any more: Marketplace, Review and Voice were the only
  // flag-gated rail rows and all three moved to `/projects/<id>/config`, whose
  // own sub-nav composes them. Nothing left in the rail varies by flag.
  const allSettingsGroups = useMemo(
    () => settingsPaletteGroups({ hasProject: !!projectId }),
    [projectId],
  );

  const filteredSettingsGroups = useMemo(
    () => (hasQuery ? filterSettingsPaletteGroups(allSettingsGroups, query) : []),
    [allSettingsGroups, hasQuery, query],
  );

  const settingsResultCount = useMemo(
    () => filteredSettingsGroups.reduce((total, group) => total + group.items.length, 0),
    [filteredSettingsGroups],
  );

  const visibleAgents = useMemo(() => {
    if (!agents) return [];
    const projectOnlyAgents = new Set(['project-manager']);
    return agents.filter(
      (a) => !a.hidden && (featureFlags.enableProjects || !projectOnlyAgents.has(a.name)),
    );
  }, [agents]);

  const filteredAgents = useMemo(() => {
    if (!visibleAgents.length) return [];
    const q = query.trim().toLowerCase();
    return visibleAgents.filter(
      (a) =>
        (a.name || '').toLowerCase().includes(q) || (a.description || '').toLowerCase().includes(q),
    );
  }, [visibleAgents, query]);

  const primaryAgents = useMemo(
    () => filteredAgents.filter((a) => a.mode !== 'subagent'),
    [filteredAgents],
  );
  const subAgents = useMemo(
    () => filteredAgents.filter((a) => a.mode === 'subagent'),
    [filteredAgents],
  );

  const visibleModels = useMemo(() => {
    const q = query.trim().toLowerCase();
    // Same rule as the session picker: only what the project OFFERS
    // (server-resolved `enabled`, `/model-picker`). Searching does not resurface
    // a disabled model — "Manage models" is where the full catalog lives.
    return allModels
      .filter((m) => {
        if (m.enabled === false) return false;
        return (
          !q ||
          (m.modelName || '').toLowerCase().includes(q) ||
          (m.modelID || '').toLowerCase().includes(q) ||
          (m.providerName || '').toLowerCase().includes(q)
        );
      })
      .sort((a, b) => (a.modelName || '').localeCompare(b.modelName || ''));
  }, [allModels, query]);

  const groupedModels = useMemo(() => {
    const groups = new Map<
      string,
      { providerID: string; providerName: string; models: typeof visibleModels }
    >();
    for (const m of visibleModels) {
      // Under the gateway every model is registered as opencode provider
      // `kortix`, so `m.providerName` is always "Kortix" — even for a BYOK
      // Anthropic/Bedrock model. Group/label by the resolved REAL upstream
      // provider instead. Safe to call unconditionally: for a native
      // (non-gateway) model `pickerGroupId` already returns `m.providerID`
      // as-is. See model-grouping.ts's doc comment.
      const groupID = pickerGroupId(m);
      const existing = groups.get(groupID);
      if (existing) {
        existing.models.push(m);
      } else {
        groups.set(groupID, {
          providerID: groupID,
          providerName: pickerGroupLabel(groupID, m),
          models: [m],
        });
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

  const newSession = useNewProjectSession(projectId ?? undefined);
  const handleNewSession = useCallback(() => {
    if (projectId) {
      newSession();
      close();
      return;
    }

    if (isCreating) return;
    setIsCreating(true);
    createSession
      .mutateAsync()
      .then((session) => {
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
      })
      .catch(() => errorToast('Failed to create session'))
      .finally(() => setIsCreating(false));
  }, [isCreating, projectId, newSession, createSession, openProjectTab, close]);

  const setSelectedAccountId = useCurrentAccountStore((s) => s.setSelectedAccountId);

  const handleSelectProject = useCallback(
    (p: KortixProject) => {
      router.push(`/projects/${p.project_id}`);
      close();
    },
    [router, close],
  );

  const handleSelectAccount = useCallback(
    (a: KortixAccount) => {
      setSelectedAccountId(a.account_id);
      // The landing door, NOT `latestProjectPath`: the last-project cookie
      // names a project in the account just left, which still passes the
      // ownership check (it's scoped by user, not account) and would open
      // the wrong account's workspace. Same rule `account-switcher.tsx`
      // follows after creating an account.
      router.push(PROJECT_LANDING_PATH);
      close();
    },
    [setSelectedAccountId, router, close],
  );

  const handleSelectProjectSession = useCallback(
    (s: ProjectSession) => {
      if (!projectId) return close();
      openProjectTab(projectId, s.session_id);
      router.push(`/projects/${projectId}/sessions/${s.session_id}`);
      close();
    },
    [projectId, openProjectTab, router, close],
  );

  const sessionName = (s: ProjectSession) =>
    s.name ||
    (typeof s.metadata?.session_name === 'string' ? s.metadata.session_name : '') ||
    s.branch_name ||
    s.session_id.slice(0, 8);

  const sortedProjects = useMemo(
    () =>
      [...(projectsList ?? [])].sort((a, b) =>
        (b.last_opened_at || b.updated_at).localeCompare(a.last_opened_at || a.updated_at),
      ),
    [projectsList],
  );

  const filteredProjectsList = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (
      q ? sortedProjects.filter((p) => p.name.toLowerCase().includes(q)) : sortedProjects
    ).slice(0, 50);
  }, [sortedProjects, query]);

  const recentProjectSessions = useMemo(() => {
    return sortSessionsByLastActivity(projectSessionsList ?? []).slice(0, 5);
  }, [projectSessionsList]);

  const recentProjects = useMemo(() => sortedProjects.slice(0, 5), [sortedProjects]);

  const filteredAccountsList = useMemo(() => {
    const q = query.trim().toLowerCase();
    const sorted = [...(accountsList ?? [])].sort((a, b) =>
      (a.name || '').localeCompare(b.name || ''),
    );
    return q ? sorted.filter((a) => (a.name || '').toLowerCase().includes(q)) : sorted;
  }, [accountsList, query]);

  const filteredDensityOptions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return DENSITY_PAGE_OPTIONS;
    return DENSITY_PAGE_OPTIONS.filter((option) =>
      `${option.label} ${option.description}`.toLowerCase().includes(q),
    );
  }, [query]);

  const filteredProjectSessionsList = useMemo(() => {
    const q = query.trim().toLowerCase();
    const sorted = sortSessionsByLastActivity(projectSessionsList ?? []);
    return (q ? sorted.filter((s) => sessionName(s).toLowerCase().includes(q)) : sorted).slice(
      0,
      50,
    );
  }, [projectSessionsList, query]);

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
  const hasSettingsResults = settingsResultCount > 0;
  const hasAnyResults =
    hasNavResults ||
    hasSessionResults ||
    hasProjectResults ||
    hasSessionActionResults ||
    hasSettingsResults;

  const showNoResults = hasQuery && queryLongEnough && !hasAnyResults;

  const handleNavigate = useCallback(
    (path: string, label?: string) => {
      const type = path.startsWith('/settings') ? ('settings' as const) : ('page' as const);
      openTabAndNavigate(
        {
          id: `page:${path}`,
          title: label || path.split('/').pop() || '',
          type,
          href: path,
        },
        router,
      );
      close();
    },
    [router, close],
  );

  const handleSelectFile = useCallback(
    (_filePath: string, _lineNumber?: number) => {
      if (!projectId) return close();
      router.push(`/projects/${projectId}/files`);
      close();
    },
    [projectId, router, close],
  );

  const jumpToMessage = useMessageJumpStore((s) => s.jumpToMessage);

  const handleJumpToMessage = useCallback(
    (messageId: string) => {
      jumpToMessage(messageId);
      close();
    },
    [jumpToMessage, close],
  );

  const detectedUrl = useMemo(() => {
    const q = query.trim();
    if (!q) return null;

    const localhostParsed = parseLocalhostUrl(q.startsWith('http') ? q : `http://${q}`);
    if (localhostParsed) {
      return { kind: 'localhost' as const, ...localhostParsed };
    }

    if (/^\d{2,5}$/.test(q)) {
      const port = Number.parseInt(q, 10);
      if (port >= 1 && port <= 65535) {
        return {
          kind: 'localhost' as const,
          originalUrl: `http://localhost:${port}/`,
          port,
          path: '/',
        };
      }
    }

    const normalized = normalizeExternalInput(q);
    if (normalized) {
      if (!q.includes('/')) {
        const ext = q.split('.').pop()?.toLowerCase() || '';
        const FILE_EXTS = new Set([
          'ts',
          'tsx',
          'js',
          'jsx',
          'json',
          'md',
          'mdx',
          'css',
          'scss',
          'less',
          'html',
          'xml',
          'yaml',
          'yml',
          'toml',
          'txt',
          'log',
          'env',
          'lock',
          'sql',
          'db',
          'py',
          'rb',
          'rs',
          'go',
          'java',
          'sh',
          'bash',
          'zsh',
          'conf',
          'cfg',
          'ini',
          'svg',
          'png',
          'jpg',
          'jpeg',
          'gif',
          'ico',
          'woff',
          'woff2',
          'ttf',
          'eot',
          'map',
          'd',
          'mjs',
          'cjs',
          'mts',
          'cts',
          'vue',
          'svelte',
          'astro',
          'wasm',
          'zip',
          'tar',
          'gz',
          'pdf',
          'docx',
          'pptx',
          'xlsx',
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
      const extUrl = detectedUrl.url;
      const proxyUrl = buildWebProxyUrl(extUrl, subdomainOpts) || extUrl;
      let displayHost: string;
      try {
        displayHost = new URL(extUrl).hostname;
      } catch {
        displayHost = extUrl;
      }

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

  const handleTogglePanelMode = useCallback(() => {
    close();
    const nextMode = panelMode === 'easy' ? 'advanced' : 'easy';
    track('panel_mode_switched', { to: nextMode });
    useUserPreferencesStore.getState().togglePanelMode();
  }, [close, panelMode]);

  /**
   * A row on the 'density' submenu page. Re-picking the current mode writes
   * nothing and tracks nothing — it is a confirmation, not a switch. The toast
   * is the only immediate feedback this preference has: unlike theme or
   * wallpaper, nothing on screen changes until the next working turn.
   */
  const handleSelectDensity = useCallback(
    (next: ConversationDensity) => {
      close();
      if (next === conversationDensity) return;
      track('conversation_density_switched', { to: next });
      useUserPreferencesStore.getState().setConversationDensity(next);
      successToast(`Conversation density set to ${next === 'minimal' ? 'Minimal' : 'Normal'}`);
    },
    [close, conversationDensity],
  );

  /**
   * "Open Terminal" / "Open Audit" / "Open Browser" / "Open Files" (Easy: the
   * Easy panel's detail layer, Advanced: the panel's corresponding tab). The
   * id-space-sensitive branching lives in `openSessionQuickView` — shared
   * with the session header's terminal/browser/files buttons, so it can never
   * drift between them.
   */
  const handleOpenQuickView = useCallback(
    (view: 'terminal' | 'audit' | 'browser' | 'files') => {
      close();
      openSessionQuickView(view, 'palette');
    },
    [close],
  );

  const handleOpenSessionTerminal = useCallback(
    () => handleOpenQuickView('terminal'),
    [handleOpenQuickView],
  );
  const handleOpenSessionAudit = useCallback(
    () => handleOpenQuickView('audit'),
    [handleOpenQuickView],
  );
  const handleOpenSessionBrowser = useCallback(
    () => handleOpenQuickView('browser'),
    [handleOpenQuickView],
  );
  const handleOpenSessionFiles = useCallback(
    () => handleOpenQuickView('files'),
    [handleOpenQuickView],
  );

  /**
   * The ONE door every settings destination goes through.
   *
   * **The rule: open the overlay only where it is mounted, otherwise
   * navigate.** `SettingsPanel` has exactly two mounts — `ProjectShell`
   * (`project-layout/project-shell.tsx`, every `/projects/*` route) and
   * `StandaloneSettingsRoute` (`/settings`, which mounts no palette). This
   * palette also mounts under `AppHeader`, whose only route group is
   * `/accounts/**`, and that layout renders no panel. `projectId` is non-null
   * exactly on `/projects/*` (see its definition above), so it is precisely
   * the "is the panel mounted?" signal.
   *
   * Calling `openSettings()` where no panel is mounted did two things, both
   * bad: the click did nothing, AND `open: true` stuck in the module-level
   * store (`stores/settings-panel-store.ts`), so the overlay sprang open
   * unrequested on the next client-side navigation into a project.
   */
  const openSettingsTab = useCallback(
    (tab: SettingsTab) => {
      close();
      if (projectId) {
        useSettingsPanelStore.getState().openSettings(tab);
        return;
      }
      router.push(`/settings/${tab}`);
    },
    [close, projectId, router],
  );

  const handleOpenSettings = useCallback(
    (tab: SettingsTabId) => {
      openSettingsTab(LEGACY_SETTINGS_TAB_MAP[tab] ?? DEFAULT_SETTINGS_TAB);
    },
    [openSettingsTab],
  );

  const handleOpenPlan = useCallback(() => {
    close();
    // Previously opened NewInstanceModal, which no surface mounts — this
    // command was a no-op. GlobalUpgradeModal is the live plan surface.
    openUpgradeDialog({ reason: 'subscription_required' });
  }, [close, openUpgradeDialog]);

  const handleLogout = useCallback(() => {
    reopenPaletteRef.current = true;
    close();
    setLogoutConfirmOpen(true);
  }, [close]);

  const performLogout = useCallback(async () => {
    reopenPaletteRef.current = false;
    const supabase = createClient();
    await supabase.auth.signOut();
    clearUserLocalStorage();
    await clearSessionIDBCache();
    router.push('/auth');
  }, [router]);

  const handleSetTheme = useCallback(
    (newTheme: string) => {
      setTheme(newTheme);
      close();
    },
    [setTheme, close],
  );

  const handleSetWallpaper = useCallback(
    (newWallpaperId: string) => {
      useUserPreferencesStore.getState().setWallpaperId(newWallpaperId);
      close();
    },
    [close],
  );

  const handleCompactSession = useCallback(() => {
    if (!currentSessionId) return;
    reopenPaletteRef.current = true;
    close();
    setCompactOpen(true);
  }, [currentSessionId, close]);

  const handleViewChanges = useCallback(() => {
    if (!currentSessionId) return;
    reopenPaletteRef.current = true;
    close();
    setDiffOpen(true);
  }, [currentSessionId, close]);

  /**
   * "Invite members" — the project Members capability tab is gone; access
   * for a project is now granted from the account hub's Access tab, scoped to
   * this project via `?project=`. There is no one-shot "open the grant
   * dialog" intent to carry across (the old `membersTab: 'invite'` field
   * belonged to the deleted page's sub-tab model, with no equivalent here) —
   * landing pre-filtered on this project's row is enough. Nice-to-have: wire
   * a real "open grant dialog" intent once `AccessProjectsTab` exposes a prop
   * for it.
   */
  const handleInviteMembers = useCallback(() => {
    if (!projectId || !inviteMembersAccountId) return;
    router.push(`/accounts/${inviteMembersAccountId}?tab=access-projects&project=${projectId}`);
    close();
  }, [close, projectId, inviteMembersAccountId, router]);

  const handleOverlayClose = useCallback(
    (set: (open: boolean) => void) => (overlayOpen: boolean) => {
      set(overlayOpen);
      if (!overlayOpen && reopenPaletteRef.current) {
        reopenPaletteRef.current = false;
        setOpen(true);
        triggerBackScale();
      }
    },
    [triggerBackScale],
  );

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

  // A rejected promise is not guaranteed to carry an Error, and a toast reading
  // "undefined" is worse than a generic one.
  const reloadErrorMessage = (err: unknown): string =>
    err instanceof Error && err.message ? err.message : 'Restart failed';

  const handleRestartConfig = useCallback(() => {
    close();
    systemReload('dispose-only')
      .then((r) =>
        r.success
          ? successToast('Config reloaded')
          : errorToast(r.errors[0] ?? 'The sandbox did not confirm the reload'),
      )
      .catch((err: unknown) => errorToast(reloadErrorMessage(err)));
  }, [close]);

  const handleReconcileSession = useCallback(() => {
    if (!currentSessionId) return;
    close();
    sendToSession(
      currentSessionId,
      buildAgentGitReconciliationPrompt(currentProjectSession?.base_ref),
    )
      .then((disposition) =>
        successToast(
          disposition === 'queued'
            ? 'Branch sync queued after the current turn'
            : 'Asked the agent to sync the branch',
        ),
      )
      .catch((err: unknown) =>
        errorToast(err instanceof Error ? err.message : 'Could not reach the agent'),
      );
  }, [close, currentProjectSession?.base_ref, currentSessionId, sendToSession]);

  const actionHandlers: Record<string, () => void> = useMemo(
    () => ({
      newSession: handleNewSession,
      openTerminal: handleOpenTerminal,
      compactSession: handleCompactSession,
      viewChanges: handleViewChanges,
      inviteMembers: handleInviteMembers,
      toggleSidebar: handleToggleSidebar,
      togglePanelMode: handleTogglePanelMode,
      // Fallback only: SUBMENU_PAGE_BY_ID intercepts `activity-density`
      // before the action branch runs. If that map entry is ever removed, the
      // row still opens the picker instead of dead-ending.
      conversationDensity: () => goToPage('density'),
      openSessionTerminal: handleOpenSessionTerminal,
      openSessionAudit: handleOpenSessionAudit,
      openSessionBrowser: handleOpenSessionBrowser,
      openSessionFiles: handleOpenSessionFiles,
      logout: handleLogout,
      openPlan: handleOpenPlan,
      openProviderModal: handleOpenProviderModal,
      generateSSHKey: handleGenerateSSHKey,
      restartConfig: handleRestartConfig,
      reconcileSession: handleReconcileSession,
    }),
    [
      handleNewSession,
      handleOpenTerminal,
      handleCompactSession,
      handleViewChanges,
      handleInviteMembers,
      handleToggleSidebar,
      handleTogglePanelMode,
      goToPage,
      handleOpenSessionTerminal,
      handleOpenSessionAudit,
      handleOpenSessionBrowser,
      handleOpenSessionFiles,
      handleLogout,
      handleOpenPlan,
      handleOpenProviderModal,
      handleGenerateSSHKey,
      handleRestartConfig,
      handleReconcileSession,
    ],
  );

  const handleRegistryItem = useCallback(
    (item: MenuItemDef) => {
      switch (item.kind) {
        case 'navigate': {
          const href = item.href || '';

          // See resolveSettingsOverlayHref's doc comment for why a stale
          // `/settings/<graduated-or-unknown-tab>` href must fall through
          // to router.push below instead of opening the overlay.
          const overlayMatch = resolveSettingsOverlayHref(href);
          if (overlayMatch.opensOverlay) {
            // A tab-less `/settings` href resolves to `tab: undefined`, which
            // `openSettings` reads as "keep whatever was last open" — a
            // non-deterministic destination for a deterministic click. Name
            // the tab instead: the project workspace default with a project,
            // the account-scoped default without one (`general` is itself a
            // project tab and is filtered out of a project-less rail).
            openSettingsTab(
              overlayMatch.tab ??
                (projectId ? DEFAULT_SETTINGS_TAB : PALETTE_NO_PROJECT_DEFAULT_TAB),
            );
            break;
          }

          if (href.startsWith('/projects') || href.startsWith('/accounts')) {
            router.push(href);
            close();
            break;
          }

          const tabType = (item.tabType ||
            (href.startsWith('/settings') ? 'settings' : 'page')) as any;
          const tabId = item.tabId || `page:${href}`;
          openTabAndNavigate(
            {
              id: tabId,
              title: item.label || href.split('/').pop() || '',
              type: tabType,
              href,
              ...(item.tabType === 'preview'
                ? { metadata: { url: '', port: 0, originalUrl: '', path: '/' } }
                : {}),
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
        case 'wallpaper':
          handleSetWallpaper(item.wallpaperValue!);
          break;
        case 'action': {
          const handler = actionHandlers[item.actionId!];
          if (handler) handler();
          break;
        }
      }
    },
    [
      router,
      close,
      projectId,
      openSettingsTab,
      handleOpenSettings,
      handleSetTheme,
      handleSetWallpaper,
      actionHandlers,
    ],
  );

  const handleSelectAgent = useCallback(
    (agentName: string) => {
      if (!currentSessionId) return;
      modelStore.setSessionAgentName(currentSessionId, agentName);
      successToast(`Agent switched to ${agentName}`);
      close();
    },
    [currentSessionId, modelStore, close],
  );

  const handleSelectModel = useCallback(
    (providerID: string, modelID: string) => {
      if (!currentAgent) return;
      modelStore.setSelectedModel(currentAgent.name, { providerID, modelID });
      modelStore.pushRecent({ providerID, modelID });
      const model = allModels.find((m) => m.providerID === providerID && m.modelID === modelID);
      successToast(`Model switched to ${model?.modelName || modelID}`);
      close();
    },
    [currentAgent, modelStore, allModels, close],
  );

  const totalSearchResults = useMemo(() => {
    if (page === 'agents') return filteredAgents.length;
    if (page === 'models') return visibleModels.length;
    if (page === 'projects') return filteredProjectsList.length;
    if (page === 'accounts') return filteredAccountsList.length;
    if (page === 'sessions') return filteredProjectSessionsList.length;
    if (page === 'density') return filteredDensityOptions.length;
    if (page === 'messages') return 0;
    if (!hasQuery) return 0;
    return (
      filteredNavItems.length +
      rootSessionResults.length +
      rootProjectResults.length +
      sessionActionItems.length +
      settingsResultCount
    );
  }, [
    page,
    hasQuery,
    filteredNavItems,
    rootSessionResults,
    rootProjectResults,
    sessionActionItems,
    settingsResultCount,
    filteredAgents,
    visibleModels,
    filteredProjectsList,
    filteredAccountsList,
    filteredProjectSessionsList,
    filteredDensityOptions,
  ]);

  const placeholder = useMemo(() => {
    if (page === 'agents') return 'Search agents...';
    if (page === 'models') return 'Search models...';
    if (page === 'files') return 'Search files in this project...';
    if (page === 'messages') return 'Search messages...';
    if (page === 'projects') return 'Search projects...';
    if (page === 'accounts') return 'Search accounts...';
    if (page === 'sessions') return 'Search sessions...';
    if (page === 'density') return 'Choose conversation density...';
    return 'Search commands, sessions...';
  }, [page]);

  const pageTitle = useMemo(() => {
    if (page === 'agents') return 'Change Agent';
    if (page === 'models') return 'Change Model';
    if (page === 'files') return 'Search Files';
    if (page === 'messages') return 'Jump to Message';
    if (page === 'projects') return 'Switch Project';
    if (page === 'accounts') return 'Switch Account';
    if (page === 'sessions') return 'Open Session';
    if (page === 'density') return 'Conversation Density';
    return null;
  }, [page]);

  return (
    <>
      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        className={cn(
          'origin-center transition-transform duration-150 ease-in-out sm:max-w-[680px]',
          backScale && 'scale-[0.99]',
        )}
        showCloseButton={false}
      >
        <CommandInput
          ref={inputRef}
          placeholder={placeholder}
          value={query}
          onValueChange={setQuery}
        />

        <FadedScrollArea fadeColor="from-popover" className="max-h-[min(60vh,380px)] min-h-[400px]">
          <CommandList className="max-h-none overflow-visible">
            {page === 'root' && (
              <>
                {!hasQuery && (
                  <>
                    <CommandGroup heading="Suggestions" forceMount>
                      <div className="space-y-0.5">
                        {allPaletteItems
                          .filter((item) => item.group === 'actions' || item.group === 'navigation')
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
                                value={sanitizeCmdkValue(
                                  `suggestion ${buildPaletteSearchText(item)}`,
                                )}
                                onSelect={() =>
                                  submenuPage ? goToPage(submenuPage) : handleRegistryItem(item)
                                }
                                disabled={item.id === 'new-session' && isCreating}
                              >
                                {item.id === 'new-session' && isCreating ? (
                                  <Loading className="text-muted-foreground size-4 shrink-0" />
                                ) : (
                                  <DisplayIcon className="size-4" />
                                )}
                                <span className="flex-1">{displayLabel}</span>
                                {item.shortcut && (
                                  <CommandShortcut>{item.shortcut}</CommandShortcut>
                                )}
                                {submenuPage && (
                                  <ChevronRight className="text-muted-foreground/30 size-3" />
                                )}
                              </CommandItem>
                            );
                          })}
                      </div>

                      {currentSessionId && (
                        <>
                          <CommandItem
                            value="suggestion change agent worker switch"
                            onSelect={() => goToPage('agents')}
                          >
                            <Bot className="size-4" />
                            <span className="flex-1">
                              {tHardcodedUi.raw(
                                'componentsCommandPalette.line1209JsxTextChangeAgent',
                              )}
                            </span>
                            {currentAgent && (
                              <span className="text-muted-foreground/40 text-xs">
                                {currentAgent.name}
                              </span>
                            )}
                            <ChevronRight className="text-muted-foreground/30 size-3" />
                          </CommandItem>
                          <CommandItem
                            value="suggestion change model llm switch"
                            onSelect={() => goToPage('models')}
                          >
                            <Cpu className="size-4" />
                            <span className="flex-1">
                              {tHardcodedUi.raw(
                                'componentsCommandPalette.line1220JsxTextChangeModel',
                              )}
                            </span>
                            {currentModelKey && (
                              <span className="text-muted-foreground/40 max-w-[160px] truncate text-xs">
                                {allModels.find(
                                  (m) =>
                                    m.providerID === currentModelKey.providerID &&
                                    m.modelID === currentModelKey.modelID,
                                )?.modelName || currentModelKey.modelID}
                              </span>
                            )}
                            <ChevronRight className="text-muted-foreground/30 size-3" />
                          </CommandItem>
                          <CommandItem
                            value="suggestion jump to message go scroll navigate"
                            onSelect={() => goToPage('messages')}
                          >
                            <MessageCircle className="size-4" />
                            <span className="flex-1">
                              {tHardcodedUi.raw(
                                'componentsCommandPalette.line1235JsxTextJumpToMessage',
                              )}
                            </span>
                            <ChevronRight className="text-muted-foreground/30 size-3" />
                          </CommandItem>
                        </>
                      )}

                      {projectId && (
                        <CommandItem
                          value="suggestion search files find file grep repo content"
                          onSelect={() => goToPage('files')}
                        >
                          <Search />
                          <span className="flex-1">
                            {tHardcodedUi.raw(
                              'componentsCommandPalette.line1248JsxTextSearchFiles',
                            )}
                          </span>
                          <Badge variant="kortix" size="sm">
                            repo
                          </Badge>
                          <ChevronRight className="text-muted-foreground/40 size-3" />
                        </CommandItem>
                      )}
                    </CommandGroup>

                    {projectId && recentProjectSessions.length > 0 && (
                      <CommandGroup
                        heading={tHardcodedUi.raw(
                          'componentsCommandPalette.line1260JsxAttrHeadingRecentSessions',
                        )}
                        forceMount
                      >
                        {recentProjectSessions.map((session) => (
                          <CommandItem
                            key={session.session_id}
                            value={sanitizeCmdkValue(
                              `recent ${sessionName(session)} ${session.session_id}`,
                            )}
                            onSelect={() => handleSelectProjectSession(session)}
                          >
                            <MessageCircle className="size-4 shrink-0" />
                            <span className="flex-1 truncate">{sessionName(session)}</span>
                            <SessionSharedIcon session={session} />
                            <span className="text-muted-foreground/30 shrink-0 text-xs tabular-nums">
                              {formatRelativeTime(
                                new Date(sessionLastActivityAt(session)).getTime(),
                              )}
                            </span>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    )}

                    {!projectId && recentProjects.length > 0 && (
                      <CommandGroup
                        heading={tHardcodedUi.raw(
                          'componentsCommandPalette.line1281JsxAttrHeadingRecentProjects',
                        )}
                        forceMount
                      >
                        {recentProjects.map((project) => (
                          <CommandItem
                            key={project.project_id}
                            value={sanitizeCmdkValue(
                              `recent project ${project.name} ${project.project_id}`,
                            )}
                            onSelect={() => handleSelectProject(project)}
                          >
                            <FolderGit2 className="size-4 shrink-0" />
                            <span className="flex-1 truncate">{project.name}</span>
                            {(project.last_opened_at || project.updated_at) && (
                              <span className="text-muted-foreground/30 shrink-0 text-xs tabular-nums">
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

                {hasQuery && (
                  <>
                    {hasSessionActionResults && (
                      <CommandGroup heading="Session" forceMount>
                        {sessionActionItems.map((item) => (
                          <CommandItem
                            key={item.id}
                            value={`${item.label} ${item.keywords}`}
                            onSelect={() => goToPage(item.targetPage)}
                          >
                            {item.id === 'change-agent' ? (
                              <Bot className="size-4" />
                            ) : item.id === 'jump-to-message' ? (
                              <MessageCircle className="size-4" />
                            ) : (
                              <Cpu className="size-4" />
                            )}
                            <span className="flex-1">{item.label}</span>
                            <ChevronRight className="text-muted-foreground/30 size-3" />
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    )}

                    {hasNavResults && (
                      <CommandGroup heading="Navigation" forceMount>
                        {filteredNavItems.map((item) => {
                          const Icon = item.icon;
                          const isToggleSidebar = item.id === 'toggle-sidebar';
                          const isTogglePanelMode = item.id === 'toggle-panel-mode';
                          const SidebarIcon = isToggleSidebar
                            ? sidebarOpen
                              ? PanelLeftClose
                              : PanelLeftIcon
                            : Icon;
                          const displayLabel = isToggleSidebar
                            ? sidebarOpen
                              ? 'Collapse Sidebar'
                              : 'Expand Sidebar'
                            : isTogglePanelMode
                              ? panelMode === 'easy'
                                ? 'Switch to Advanced View'
                                : 'Switch to Easy View'
                              : item.label;
                          const isActiveTheme = item.kind === 'theme' && theme === item.themeValue;
                          const isActiveWallpaper =
                            item.kind === 'wallpaper' && activeWallpaperId === item.wallpaperValue;
                          const submenuPage = SUBMENU_PAGE_BY_ID[item.id];

                          return (
                            <CommandItem
                              key={item.id}
                              value={buildPaletteSearchText(item)}
                              onSelect={() =>
                                submenuPage ? goToPage(submenuPage) : handleRegistryItem(item)
                              }
                              disabled={item.id === 'new-session' && isCreating}
                            >
                              {item.id === 'new-session' && isCreating ? (
                                <Loading className="text-muted-foreground size-4 shrink-0" />
                              ) : (
                                <SidebarIcon className="size-4" />
                              )}
                              <span className="flex-1">{displayLabel}</span>
                              {item.shortcut && <CommandShortcut>{item.shortcut}</CommandShortcut>}
                              {(isActiveTheme || isActiveWallpaper) && (
                                <span className="text-primary/60 text-xs font-medium">Active</span>
                              )}
                              {submenuPage && (
                                <ChevronRight className="text-muted-foreground/30 size-3" />
                              )}
                            </CommandItem>
                          );
                        })}
                      </CommandGroup>
                    )}

                    {/* One group per rail group, headings and order intact.
                        Flattening them would strip the only thing that tells
                        Workspace › General and Organization › General apart —
                        the same reason `filterRailGroups` keeps the rail's
                        groups through a search. */}
                    {filteredSettingsGroups.map((group) => (
                      <CommandGroup
                        key={group.label}
                        heading={`Settings · ${group.label}`}
                        forceMount
                      >
                        {group.items.map((item) => {
                          const SettingsIcon = item.icon;
                          return (
                            <CommandItem
                              key={item.id}
                              // `item.tab` is deliberately absent — an internal
                              // slug, same class as the registry `id` dropped
                              // from the Navigation rows above.
                              value={sanitizeCmdkValue(
                                `settings ${settingsPaletteSearchText(item)}`,
                              )}
                              onSelect={() => openSettingsTab(item.tab)}
                            >
                              <SettingsIcon className="size-4" />
                              <span className="flex-1">{item.label}</span>
                            </CommandItem>
                          );
                        })}
                      </CommandGroup>
                    ))}

                    {hasSessionResults && (
                      <CommandGroup heading="Sessions" forceMount>
                        {rootSessionResults.map((session) => (
                          <CommandItem
                            key={session.session_id}
                            value={sanitizeCmdkValue(
                              `session ${sessionName(session)} ${session.session_id}`,
                            )}
                            onSelect={() => handleSelectProjectSession(session)}
                          >
                            <MessageCircle className="size-4 shrink-0" />
                            <span className="flex-1 truncate">{sessionName(session)}</span>
                            <SessionSharedIcon session={session} />
                            {session.session_id === params?.sessionId && (
                              <Check className="text-primary h-3.5 w-3.5 shrink-0" />
                            )}
                            <span className="text-muted-foreground/40 shrink-0 text-xs tabular-nums">
                              {formatRelativeTime(
                                new Date(sessionLastActivityAt(session)).getTime(),
                              )}
                            </span>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    )}

                    {hasProjectResults && (
                      <CommandGroup heading="Projects" forceMount>
                        {rootProjectResults.map((project) => (
                          <CommandItem
                            key={project.project_id}
                            value={sanitizeCmdkValue(
                              `project ${project.name} ${project.project_id}`,
                            )}
                            onSelect={() => handleSelectProject(project)}
                          >
                            <FolderGit2 className="size-4 shrink-0" />
                            <span className="flex-1 truncate">{project.name}</span>
                            {(project.last_opened_at || project.updated_at) && (
                              <span className="text-muted-foreground/40 shrink-0 text-xs tabular-nums">
                                {formatRelativeTime(
                                  new Date(project.last_opened_at || project.updated_at).getTime(),
                                )}
                              </span>
                            )}
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    )}

                    {detectedUrl && (
                      <CommandGroup
                        heading={tHardcodedUi.raw(
                          'componentsCommandPalette.line1419JsxAttrHeadingOpenURL',
                        )}
                        forceMount
                      >
                        <CommandItem
                          value={sanitizeCmdkValue(
                            `open url browser preview ${query.trim()} localhost port`,
                          )}
                          onSelect={handleOpenUrl}
                        >
                          <Globe className="text-kortix-blue size-4" />
                          <span className="flex-1 truncate">
                            {detectedUrl.kind === 'localhost'
                              ? `Open localhost:${detectedUrl.port}${detectedUrl.path !== '/' ? detectedUrl.path : ''}`
                              : `Open ${new URL(detectedUrl.url).hostname}`}
                          </span>
                          <Badge variant="kortix" size="sm">
                            browser
                          </Badge>
                        </CommandItem>
                      </CommandGroup>
                    )}

                    {queryLongEnough && !detectedUrl && projectId && (
                      <CommandGroup
                        heading={tHardcodedUi.raw(
                          'componentsCommandPalette.line1437JsxAttrHeadingFileSearch',
                        )}
                        forceMount
                      >
                        <CommandItem
                          value={sanitizeCmdkValue(
                            `search files ${query.trim()} repo grep find open`,
                          )}
                          onSelect={() => goToPage('files', true)}
                        >
                          <span className="flex-1">
                            {tHardcodedUi.raw(
                              'componentsCommandPalette.line1444JsxTextSearchFilesFor',
                            )}
                            {query.trim()}
                            {tHardcodedUi.raw('componentsCommandPalette.line1444JsxTextText')}
                          </span>
                          <Badge variant="kortix" size="sm">
                            repo
                          </Badge>
                          <ChevronRight className="text-muted-foreground/40 size-3" />
                        </CommandItem>
                      </CommandGroup>
                    )}

                    {showNoResults && (
                      <div className="flex flex-col items-center gap-2 py-12" cmdk-empty="">
                        <div className="bg-popover inline-flex size-8 shrink-0 items-center justify-center rounded-sm border font-semibold">
                          <Search className="text-muted-foreground size-4" />
                        </div>
                        <div className="text-center">
                          <span className="text-muted-foreground/60 text-sm">
                            {tHardcodedUi.raw(
                              'componentsCommandPalette.line1462JsxTextNoResultsFor',
                            )}
                            {query.trim()}
                            {tHardcodedUi.raw('componentsCommandPalette.line1462JsxTextText')}
                          </span>
                          <p className="text-muted-foreground/30 mt-1 text-xs">
                            {tHardcodedUi.raw(
                              'componentsCommandPalette.line1465JsxTextTrySearchFilesOrADifferentTerm',
                            )}
                          </p>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </>
            )}

            {page === 'agents' && (
              <>
                {primaryAgents.length > 0 && (
                  <CommandGroup heading="Agents" forceMount>
                    {primaryAgents.map((agent) => {
                      const isActive = currentAgent?.name === agent.name;
                      const chalk = chalkColors(agent.name);
                      return (
                        <CommandItem
                          key={agent.name}
                          value={sanitizeCmdkValue(
                            `agent ${agent.name} ${agent.description || ''}`,
                          )}
                          onSelect={() => handleSelectAgent(agent.name)}
                        >
                          <div
                            className="inline-flex size-8 shrink-0 items-center justify-center rounded-sm border font-semibold"
                            style={{
                              backgroundColor: chalk.background,
                              color: chalk.foreground,
                              borderColor: chalk.border,
                            }}
                          >
                            <Bot className="size-5 shrink-0" />
                          </div>
                          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                            <span className="truncate text-sm font-medium">
                              {capitalizeWords(agent.name)}
                            </span>
                            {agent.description && (
                              <span className="text-muted-foreground/50 truncate text-xs">
                                {agent.description}
                              </span>
                            )}
                          </div>
                          {isActive && <Check className="text-primary h-3.5 w-3.5 shrink-0" />}
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                )}

                {subAgents.length > 0 && (
                  <CommandGroup heading="Sub-agents" forceMount>
                    {subAgents.map((agent) => {
                      const isActive = currentAgent?.name === agent.name;
                      const isKortixAgent = agent.name.toLowerCase().includes('kortix');
                      const chalk = chalkColors(agent.name);
                      return (
                        <CommandItem
                          key={agent.name}
                          value={sanitizeCmdkValue(
                            `subagent ${agent.name} ${agent.description || ''}`,
                          )}
                          onSelect={() => handleSelectAgent(agent.name)}
                        >
                          <div
                            className="inline-flex size-8 shrink-0 items-center justify-center rounded-sm border font-semibold"
                            style={{
                              backgroundColor: chalk.background,
                              color: chalk.foreground,
                              borderColor: chalk.border,
                            }}
                          >
                            {isKortixAgent ? (
                              <Bot className="size-5 shrink-0" />
                            ) : (
                              <span>{agent.name.charAt(0).toUpperCase()}</span>
                            )}
                          </div>
                          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                            <span className="truncate text-sm">{capitalizeWords(agent.name)}</span>
                            {agent.description && (
                              <span className="text-muted-foreground/50 truncate text-xs">
                                {agent.description}
                              </span>
                            )}
                          </div>
                          {isActive && <Check className="text-primary h-3.5 w-3.5 shrink-0" />}
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                )}

                {filteredAgents.length === 0 && (
                  <div className="flex flex-col items-center gap-2 py-12" cmdk-empty="">
                    <div className="bg-popover inline-flex size-8 shrink-0 items-center justify-center rounded-sm border font-semibold">
                      <Bot className="text-muted-foreground size-4" />
                    </div>
                    <span className="text-muted-foreground/60 text-sm">
                      {query ? `No agents matching "${query}"` : 'No agents available'}
                    </span>
                  </div>
                )}
              </>
            )}

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
                          value={sanitizeCmdkValue(
                            `model ${model.providerName} ${model.modelName} ${model.modelID}`,
                          )}
                          onSelect={() => handleSelectModel(model.providerID, model.modelID)}
                        >
                          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                            <span className="truncate text-sm">{model.modelName}</span>
                            <span className="text-muted-foreground/40 truncate font-mono text-xs">
                              {model.modelID}
                            </span>
                          </div>
                          <div className="flex shrink-0 items-center gap-1.5">
                            {model.capabilities?.reasoning && (
                              <Badge variant="kortix" size="sm">
                                reasoning
                              </Badge>
                            )}
                            {model.capabilities?.vision && (
                              <Badge variant="kortix" size="sm">
                                vision
                              </Badge>
                            )}
                            {isActive && <Check className="text-primary h-3.5 w-3.5" />}
                          </div>
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                ))}

                {visibleModels.length === 0 && (
                  <div className="flex flex-col items-center gap-2 py-12" cmdk-empty="">
                    <Cpu className="text-muted-foreground/30 size-5" />
                    <span className="text-muted-foreground/60 text-sm">
                      {query ? `No models matching "${query}"` : 'No models available'}
                    </span>
                  </div>
                )}
              </>
            )}

            {page === 'files' && projectId && (
              <FileSearchPage query={query} onSelect={handleSelectFile} />
            )}

            {page === 'projects' &&
              (filteredProjectsList.length > 0 ? (
                <CommandGroup heading="Projects" forceMount>
                  {filteredProjectsList.map((project) => (
                    <CommandItem
                      key={project.project_id}
                      value={sanitizeCmdkValue(`project ${project.name} ${project.project_id}`)}
                      onSelect={() => handleSelectProject(project)}
                    >
                      <FolderGit2 className="text-muted-foreground size-4 shrink-0" />
                      <span className="flex-1 truncate">{project.name}</span>
                      {project.project_id === params?.id && (
                        <Check className="text-primary h-3.5 w-3.5 shrink-0" />
                      )}
                    </CommandItem>
                  ))}
                </CommandGroup>
              ) : (
                <div className="flex flex-col items-center gap-2 py-12" cmdk-empty="">
                  <FolderGit2 className="text-muted-foreground/30 size-5" />
                  <span className="text-muted-foreground/60 text-sm">
                    {query ? `No projects matching "${query}"` : 'No projects yet'}
                  </span>
                </div>
              ))}

            {page === 'accounts' &&
              (filteredAccountsList.length > 0 ? (
                <CommandGroup heading="Accounts" forceMount>
                  {filteredAccountsList.map((account) => {
                    const label = account.name || 'Account';
                    return (
                      <CommandItem
                        key={account.account_id}
                        value={sanitizeCmdkValue(`account ${label} ${account.account_id}`)}
                        onSelect={() => handleSelectAccount(account)}
                      >
                        <UsersSolid
                          weight="fill"
                          className="text-muted-foreground size-4 shrink-0"
                        />
                        <span className="flex-1 truncate">{label}</span>
                        {account.account_id === activeAccountId && (
                          <Check className="text-primary h-3.5 w-3.5 shrink-0" />
                        )}
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              ) : (
                <div className="flex flex-col items-center gap-2 py-12" cmdk-empty="">
                  <UsersSolid weight="fill" className="text-muted-foreground size-5" />
                  <span className="text-muted-foreground/60 text-sm">
                    {query ? `No accounts matching "${query}"` : 'No accounts'}
                  </span>
                </div>
              ))}

            {page === 'density' &&
              (filteredDensityOptions.length > 0 ? (
                <CommandGroup heading="Conversation Density" forceMount>
                  {filteredDensityOptions.map((option) => {
                    // Minimal is one line, Normal is many — let the glyphs say so.
                    const OptionIcon = option.id === 'minimal' ? Minus : TextAlignLeft;
                    return (
                      <CommandItem
                        key={option.id}
                        value={sanitizeCmdkValue(`density ${option.label}`)}
                        onSelect={() => handleSelectDensity(option.id)}
                      >
                        <OptionIcon className="text-muted-foreground size-4 shrink-0" />
                        <span className="shrink-0">{option.label}</span>
                        <span className="text-muted-foreground/60 flex-1 truncate text-xs">
                          {option.description}
                        </span>
                        {option.id === conversationDensity && (
                          <Check className="text-primary h-3.5 w-3.5 shrink-0" />
                        )}
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              ) : (
                <div className="flex flex-col items-center gap-2 py-12" cmdk-empty="">
                  <TextAlignLeft className="text-muted-foreground/30 size-5" />
                  <span className="text-muted-foreground/60 text-sm">
                    {`No density option matching "${query}"`}
                  </span>
                </div>
              ))}

            {page === 'sessions' &&
              (filteredProjectSessionsList.length > 0 ? (
                <CommandGroup heading="Sessions" forceMount>
                  {filteredProjectSessionsList.map((session) => (
                    <CommandItem
                      key={session.session_id}
                      value={sanitizeCmdkValue(
                        `session ${sessionName(session)} ${session.session_id}`,
                      )}
                      onSelect={() => handleSelectProjectSession(session)}
                    >
                      <MessageCircle className="text-muted-foreground size-4 shrink-0" />
                      <span className="flex-1 truncate">{sessionName(session)}</span>
                      <SessionSharedIcon session={session} />
                      <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                        {formatRelativeTime(new Date(sessionLastActivityAt(session)).getTime())}
                      </span>
                      {session.session_id === params?.sessionId && (
                        <Check className="text-primary h-3.5 w-3.5 shrink-0" />
                      )}
                    </CommandItem>
                  ))}
                </CommandGroup>
              ) : (
                <div className="flex flex-col items-center gap-2 py-12" cmdk-empty="">
                  <div className="bg-popover inline-flex size-8 shrink-0 items-center justify-center rounded-sm border font-semibold">
                    <MessageCircle className="text-muted-foreground size-5" />
                  </div>
                  <span className="text-muted-foreground text-sm">
                    {query ? `No sessions matching "${query}"` : 'No sessions yet'}
                  </span>
                </div>
              ))}

            {page === 'messages' && currentSessionId && (
              <MessagesPage
                sessionId={currentSessionId}
                query={query}
                onSelect={handleJumpToMessage}
              />
            )}
          </CommandList>
        </FadedScrollArea>

        <CommandFooter>
          <div className="flex items-center gap-1">
            <ArrowUp className="size-3" />
            <ArrowDown className="size-3" />
            <span>navigate</span>
          </div>
          <div className="flex items-center gap-1">
            <CornerDownLeft className="size-3" />
            <span>select</span>
          </div>
          {page === 'files' && (
            <div className="flex items-center justify-center gap-1">
              <Kbd>{tHardcodedUi.raw('componentsCommandPalette.line1744JsxTextText')}</Kbd>
              <span>
                {tHardcodedUi.raw('componentsCommandPalette.line1745JsxTextContentSearch')}
              </span>
            </div>
          )}
          {totalSearchResults > 0 && (
            <span className="ml-auto tabular-nums">
              {totalSearchResults} result{totalSearchResults !== 1 ? 's' : ''}
            </span>
          )}
        </CommandFooter>
      </CommandDialog>

      {currentSessionId && (
        <>
          <CompactModal
            sessionId={currentSessionId}
            open={compactOpen}
            onOpenChange={handleOverlayClose(setCompactOpen)}
            onCompactStart={() => {
              reopenPaletteRef.current = false;
            }}
          />
          <DiffDialog
            sessionId={currentSessionId}
            open={diffOpen}
            onOpenChange={handleOverlayClose(setDiffOpen)}
          />
        </>
      )}

      <AlertDialog open={logoutConfirmOpen} onOpenChange={handleOverlayClose(setLogoutConfirmOpen)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {tHardcodedUi.raw('autoFeaturesLayoutUserMenuJsxTextLogOutOfYour4770ea0c')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {tHardcodedUi.raw('autoFeaturesLayoutUserMenuJsxTextYouLlNeedToee9fad67')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={performLogout}>
              {tHardcodedUi.raw('componentsLayoutUserMenu.line248JsxAttrLabelLogOut')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

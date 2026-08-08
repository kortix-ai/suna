/**
 * ============================================================================
 * CENTRAL MENU REGISTRY — Single source of truth for all navigation items
 * ============================================================================
 *
 * Every menu item in the app lives here. The Command Palette (Cmd+K),
 * Right Sidebar, Left Sidebar, User Settings Menu, and Settings Modal
 * all consume these definitions — update once, synced everywhere.
 *
 * To add a new page / action:
 *   1. Add a lucide icon import below
 *   2. Add an entry to the appropriate section
 *   3. Done — it will appear in every surface that renders that section
 *
 * Each item declares which surfaces it should appear in via `showIn`.
 * Surfaces: 'commandPalette' | 'rightSidebar' | 'leftSidebar' | 'userMenu'
 * ============================================================================
 */

import { Monitor as MonitorIcon } from '@/features/icon/icons/monitor';
import { Moon } from '@/features/icon/icons/moon';
import { Sun } from '@/features/icon/icons/sun';
import { WALLPAPERS } from '@/lib/wallpapers';
import type { ExperimentalFeatureKey } from '@kortix/sdk';
import {
  ActivityIcon as Activity,
  SquaresFourIcon as Blocks,
  RobotIcon as Bot,
  CubeIcon as Boxes,
  CalendarIcon as Calendar,
  GearSixIcon as CogOne,
  GearSixIcon as CogOneSolid,
  CoinsIcon as Coins,
  CompassIcon as Compass,
  ShippingContainerIcon as Container,
  CreditCardIcon as CreditCardSolid,
  GitBranchIcon as FolderGit2,
  FolderOpenIcon as FolderOpen,
  GitDiffIcon as GitCompareArrows,
  GitPullRequestIcon as GitPullRequest,
  GlobeIcon as Globe,
  HashIcon as Hash,
  KeyboardIcon as Keyboard,
  KeyIcon as KeyRound,
  StackIcon as Layers,
  SquaresFourIcon as LayoutDashboard,
  SignOutIcon as LogOut,
  ChatsIcon as MessagesSquare,
  MonitorIcon as Monitor,
  PaletteIcon as Palette,
  SidebarSimpleIcon as PanelLeftClose,
  PlugIcon as Plug,
  PlusIcon as Plus,
  ReceiptIcon as Receipt,
  ArrowClockwiseIcon as RefreshCw,
  ScrollIcon as ScrollText,
  MagnifyingGlassIcon as Search,
  ShieldCheckIcon as ShieldCheck,
  SlidersHorizontalIcon as SlidersHorizontal,
  StorefrontIcon as Store,
  TerminalWindowIcon as Terminal,
  TerminalWindowIcon as TerminalSquare,
  UserPlusIcon as UserPlus,
  UsersIcon as UsersSolid,
  SpeakerHighIcon as Volume2,
  ImagesSquareIcon as WallpaperIcon,
  WebhooksLogoIcon as Webhook,
} from '@phosphor-icons/react';
import type { ComponentType } from 'react';

// ============================================================================
// Types
// ============================================================================

/** Where a menu item should be rendered. */
export type MenuSurface = 'commandPalette' | 'rightSidebar' | 'leftSidebar' | 'userMenu';

/**
 * How the item behaves when activated.
 *
 * - 'navigate': Opens a route in a tab (uses openTabAndNavigate)
 * - 'action':   Runs an imperative callback (e.g. "new session", "logout")
 * - 'settings': Opens the UserSettingsModal to a specific tab
 * - 'theme':    Switches the app theme
 * - 'wallpaper': Applies a wallpaper (same set as Settings → Appearance)
 * - 'sandboxService': Opens a sandbox service preview tab (needs special handler)
 */
export type MenuItemKind =
  'navigate' | 'action' | 'settings' | 'theme' | 'wallpaper' | 'sandboxService';

export type SettingsTabId =
  | 'general'
  | 'security'
  | 'appearance'
  | 'sounds'
  | 'notifications'
  | 'billing'
  | 'transactions'
  | 'referrals'
  | 'tokens'
  | 'shortcuts'
  | 'instance-members'
  | 'instance-projects';

/** The group / section a menu item belongs to. */
export type MenuGroup =
  | 'actions'
  | 'navigation'
  | 'quickActions'
  | 'settingsPages'
  | 'preferences'
  | 'account'
  | 'theme'
  | 'wallpaper'
  | 'view'
  | 'admin';

/**
 * Optional sub-group within a group for visual clustering.
 * Used by the right sidebar to add separators between logical sections
 * without changing the overall group structure.
 */
export type NavSubGroup = 'tools' | 'services' | 'security';

/** Human-readable labels for sub-groups (used in expanded sidebar) */
export const navSubGroupLabels: Record<NavSubGroup, string> = {
  tools: '',
  services: 'Services',
  security: 'Security',
};

export interface MenuItemDef {
  /** Unique identifier for this item (used as React key, cmdk value, etc.) */
  id: string;
  /** Display label */
  label: string;
  /** Lucide icon component */
  icon: ComponentType<{ className?: string }>;
  /** Which group/section this belongs to */
  group: MenuGroup;
  /** Which UI surfaces should render this item */
  showIn: MenuSurface[];

  // --- Behaviour ---
  kind: MenuItemKind;

  /** For kind='navigate': the route to navigate to */
  href?: string;
  /** For kind='navigate': tab type override (defaults to 'page') */
  tabType?: string;
  /** For kind='navigate': tab id override (defaults to `page:${href}`) */
  tabId?: string;
  /** For kind='navigate': additional pathname prefixes that make this item "active" */
  activePathPrefixes?: string[];

  /** For kind='settings': which settings tab to open */
  settingsTab?: SettingsTabId;
  /** For kind='theme': which theme to set */
  themeValue?: string;
  /** For kind='wallpaper': which wallpaper to apply */
  wallpaperValue?: string;
  /** For kind='sandboxService': the container port */
  sandboxPort?: string;

  /** For kind='action': a string key identifying the action (resolved at runtime) */
  actionId?: string;

  /** Optional sub-group for visual clustering within a group (e.g. right sidebar sections) */
  subGroup?: NavSubGroup;

  // --- Display hints ---
  /** Keyboard shortcut string to show (e.g. "⌘J") */
  shortcut?: string;
  /** Extra search keywords for the command palette (cmdk `value`) */
  keywords?: string;
  /** If true, item is only shown when billing is enabled */
  requiresBilling?: boolean;
  /** If true, item is only shown for admin users */
  requiresAdmin?: boolean;
  /** If true, item is only shown when there's an active session */
  requiresSession?: boolean;
  /** If true, item is only shown when a project is active (new project shell).
   *  Project-scoped hrefs use the `{projectId}` token, resolved at render. */
  requiresProject?: boolean;
  /** If true, item is only shown when the project / project-paradigm
   *  feature flag (NEXT_PUBLIC_ENABLE_PROJECTS) is on. Used to gate
   *  project-paradigm surfaces (Board today; Milestones, Team later). */
  requiresProjectsFlag?: boolean;
  /** If set, item is only shown when the named per-project experimental
   *  feature is enabled (mirrors the Customize rail gating). The palette
   *  resolves it against the active project's experimental flags. */
  requiresExperimental?: ExperimentalFeatureKey;
}

// ============================================================================
// Registry definitions
// ============================================================================

export const menuRegistry: MenuItemDef[] = [
  // ──────────────────────────────────────────────────────────────────────────
  // ACTIONS
  // ──────────────────────────────────────────────────────────────────────────
  {
    id: 'new-session',
    label: 'New Session',
    icon: Plus,
    group: 'actions',
    showIn: ['commandPalette', 'leftSidebar'],
    kind: 'action',
    actionId: 'newSession',
    shortcut: 'Ctrl+J',
  },
  {
    id: 'search',
    label: 'Search',
    icon: Search,
    group: 'actions',
    showIn: ['leftSidebar'],
    kind: 'action',
    actionId: 'openSearch',
    shortcut: 'Ctrl+K',
  },
  {
    id: 'open-terminal',
    label: 'Open Terminal',
    icon: TerminalSquare,
    group: 'actions',
    showIn: ['commandPalette'],
    kind: 'action',
    actionId: 'openTerminal',
  },
  {
    id: 'compact-session',
    label: 'Compact Session',
    icon: Layers,
    group: 'actions',
    showIn: ['commandPalette'],
    kind: 'action',
    actionId: 'compactSession',
    requiresSession: true,
  },
  {
    id: 'view-changes',
    label: 'View Changes',
    icon: GitCompareArrows,
    group: 'actions',
    showIn: ['commandPalette'],
    kind: 'action',
    actionId: 'viewChanges',
    requiresSession: true,
  },
  // NOTE: distinct id/actionId from the legacy 'open-terminal' entry below
  // (which spawns a standalone workspace PTY tab and is hidden from the
  // palette via LEGACY_PALETTE_HIDDEN in command-palette.tsx) — this one
  // opens THIS session's own terminal/audit surface (Easy detail layer /
  // Advanced tab), so it needs its own identity even though the label the
  // product wants ("Open Terminal") collides in English.
  {
    id: 'open-session-terminal',
    label: 'Open Terminal',
    icon: Terminal,
    group: 'actions',
    showIn: ['commandPalette'],
    kind: 'action',
    actionId: 'openSessionTerminal',
    keywords: 'terminal shell console pty session',
    requiresSession: true,
  },
  {
    id: 'open-session-audit',
    label: 'Open Audit',
    icon: ShieldCheck,
    group: 'actions',
    showIn: ['commandPalette'],
    kind: 'action',
    actionId: 'openSessionAudit',
    keywords: 'audit governed actions approvals trail session',
    requiresSession: true,
  },
  // Distinct id/actionId from the legacy 'agent-browser-cmd'/'internal-browser-cmd'
  // entries below (both hidden from the palette via LEGACY_PALETTE_HIDDEN in
  // command-palette.tsx, and both standalone workspace tabs) — this one opens
  // THIS session's own in-panel port browser (Easy detail layer / Advanced
  // Browser tab), the same distinction 'open-session-terminal' draws from the
  // legacy 'open-terminal'.
  {
    id: 'open-session-browser',
    label: 'Open Browser',
    icon: Globe,
    group: 'actions',
    showIn: ['commandPalette'],
    kind: 'action',
    actionId: 'openSessionBrowser',
    keywords: 'browser preview app port localhost session',
    requiresSession: true,
  },
  {
    id: 'open-session-files',
    label: 'Open Files',
    icon: FolderOpen,
    group: 'actions',
    showIn: ['commandPalette'],
    kind: 'action',
    actionId: 'openSessionFiles',
    keywords: 'files explorer workspace session',
    requiresSession: true,
  },

  {
    id: 'restart-config',
    label: 'Restart: Config Only',
    icon: RefreshCw,
    group: 'actions',
    showIn: ['commandPalette'],
    kind: 'action',
    actionId: 'restartConfig',
    keywords: 'reload restart config agents skills commands',
  },
  {
    id: 'restart-full',
    // Says what it does. This maps to the daemon's /kortix/refresh, which pulls
    // the workspace AND restarts the runtime — "Full" alone did not warn that it
    // touches the working tree, or that it ends the turn in flight.
    label: 'Restart: Pull & Restart Runtime',
    icon: RefreshCw,
    group: 'actions',
    showIn: ['commandPalette'],
    kind: 'action',
    actionId: 'restartFull',
    keywords: 'reload restart full services kill nuclear pull refresh workspace',
  },

  // ──────────────────────────────────────────────────────────────────────────
  // WORKSPACE & APP NAVIGATION (command palette — current workspace shell)
  // App-level items always show; workspace-level items use the compatibility
  // {projectId} token and only show when a workspace is active.
  // ──────────────────────────────────────────────────────────────────────────
  {
    id: 'nav-projects',
    label: 'Workspaces',
    icon: FolderGit2,
    group: 'navigation',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/workspaces',
    keywords: 'workspaces list all projects switch',
  },
  {
    id: 'nav-accounts',
    label: 'Accounts',
    icon: UsersSolid,
    group: 'navigation',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/accounts',
    keywords: 'accounts teams organizations members switch manage',
  },
  {
    id: 'proj-sessions',
    label: 'Open Session',
    icon: MessagesSquare,
    group: 'navigation',
    showIn: ['commandPalette'],
    kind: 'navigate',
    // Opens the in-palette "Open Session" sub-picker (see SUBMENU_PAGE_BY_ID);
    // the href is the routed fallback for surfaces that consume this registry
    // without the palette's nested picker.
    href: '/workspaces/{projectId}/sessions',
    requiresProject: true,
    keywords: 'sessions runs threads project conversations open',
  },
  {
    id: 'proj-customize',
    label: 'Customize',
    icon: SlidersHorizontal,
    group: 'navigation',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/workspaces/{projectId}/customize',
    requiresProject: true,
    // 'agents', 'skills' and 'commands' were deliberately dropped: those three
    // graduated out of the overlay into their own palette entries (proj-agents,
    // proj-skills, proj-commands). Keeping the words here made this bare
    // Customize entry match those queries too and — since filteredNavItems
    // preserves registry declaration order rather than ranking by relevance —
    // it listed ahead of the real Agents/Skills/Commands entries.
    keywords: 'customize configure project settings',
  },
  {
    id: 'proj-files',
    label: 'Files',
    icon: FolderOpen,
    group: 'navigation',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/workspaces/{projectId}/files',
    requiresProject: true,
    keywords: 'files repository project drive browser explorer',
  },
  {
    id: 'proj-apps',
    label: 'Apps',
    icon: Globe,
    group: 'navigation',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/workspaces/{projectId}/apps',
    requiresProject: true,
    keywords: 'apps deploy deployments serverless docker static hosting urls',
  },
  {
    id: 'proj-agents',
    label: 'Agents',
    icon: Bot,
    group: 'navigation',
    showIn: ['commandPalette'],
    kind: 'navigate',
    // The standalone page, not `/customize/agents`. That href still works —
    // `legacyCustomizeRedirect` bounces it here — but routing through the
    // redirect costs a second navigation and paints the overlay route first.
    href: '/workspaces/{projectId}/agent',
    requiresProject: true,
    keywords: 'agents subagents project customize ai',
  },
  {
    id: 'proj-skills',
    label: 'Skills',
    icon: Blocks,
    group: 'navigation',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/workspaces/{projectId}/skills',
    requiresProject: true,
    keywords: 'skills project customize abilities',
  },
  {
    id: 'proj-commands',
    label: 'Commands',
    icon: TerminalSquare,
    group: 'navigation',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/workspaces/{projectId}/customize/commands',
    requiresProject: true,
    keywords: 'commands slash project customize',
  },
  {
    id: 'proj-secrets',
    label: 'Customize · Secrets',
    icon: KeyRound,
    group: 'navigation',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/workspaces/{projectId}/customize/secrets',
    requiresProject: true,
    keywords: 'secrets env environment variables project customize',
  },
  {
    id: 'proj-connectors',
    label: 'Connectors',
    icon: Plug,
    group: 'navigation',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/workspaces/{projectId}/connectors',
    requiresProject: true,
    keywords:
      'connectors connections pipedream mcp openapi postman collections apps connector project customize',
  },
  {
    id: 'proj-connectors-policies',
    // Was "Customize · Connectors · Policies" — no longer accurate: this no
    // longer lives under Customize, and the href below cannot deep-link into
    // a Policies tab (the connectors page doesn't host one yet), so the label
    // must not promise a destination it does not reach.
    label: 'Connectors · Policies',
    icon: Plug,
    group: 'navigation',
    showIn: ['commandPalette'],
    kind: 'navigate',
    // TODO(capabilities): restore deep link to Global rules once the connectors page hosts PoliciesPanel
    href: '/workspaces/{projectId}/connectors',
    requiresProject: true,
    keywords:
      'policies approval block require_approval rules tools connector guardrails project customize',
  },
  {
    id: 'proj-git',
    label: 'Customize · Git',
    icon: GitPullRequest,
    group: 'navigation',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/workspaces/{projectId}/customize/git',
    requiresProject: true,
    keywords:
      'git repository provider github code storage clone proxy branch sync project customize',
  },
  {
    id: 'proj-sandbox',
    label: 'Customize · Sandbox templates',
    icon: Container,
    group: 'navigation',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/workspaces/{projectId}/customize/sandbox',
    requiresProject: true,
    keywords: 'sandbox templates image snapshot runtime environment project customize',
  },
  {
    id: 'proj-marketplace',
    label: 'Customize · Marketplace',
    icon: Store,
    group: 'navigation',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/workspaces/{projectId}/customize/marketplace',
    requiresProject: true,
    requiresExperimental: 'marketplace',
    keywords: 'marketplace store install templates agents skills browse project customize',
  },
  {
    id: 'proj-llm',
    label: 'Customize · LLM',
    icon: Boxes,
    group: 'navigation',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/workspaces/{projectId}/customize/llm-management',
    requiresProject: true,
    requiresExperimental: 'llm_gateway',
    keywords:
      'llm gateway providers models budgets logs api keys overview anthropic openai openrouter google groq xai project customize',
  },
  {
    id: 'proj-computers',
    label: 'Customize · Computers',
    icon: Monitor,
    group: 'navigation',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/workspaces/{projectId}/customize/computers',
    requiresProject: true,
    requiresExperimental: 'agent_tunnel',
    keywords:
      'computers tunnel machines connect reverse local devices remote agent access project customize',
  },
  {
    id: 'proj-members',
    label: 'Customize · Members',
    icon: UsersSolid,
    group: 'navigation',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/workspaces/{projectId}/customize/members',
    requiresProject: true,
    keywords: 'members team access collaborators project customize',
  },
  {
    id: 'proj-invite',
    label: 'Invite members',
    icon: UserPlus,
    group: 'navigation',
    showIn: ['commandPalette'],
    kind: 'action',
    actionId: 'inviteMembers',
    requiresProject: true,
    keywords: 'invite members add teammate email collaborator people access send project customize',
  },
  {
    id: 'proj-schedules',
    label: 'Customize · Schedules',
    icon: Calendar,
    group: 'navigation',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/workspaces/{projectId}/customize/schedules',
    requiresProject: true,
    keywords: 'schedules cron triggers timed project customize',
  },
  {
    id: 'proj-webhooks',
    label: 'Customize · Webhooks',
    icon: Webhook,
    group: 'navigation',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/workspaces/{projectId}/customize/webhooks',
    requiresProject: true,
    keywords: 'webhooks triggers http project customize',
  },
  {
    id: 'proj-channels',
    label: 'Customize · Channels',
    icon: Hash,
    group: 'navigation',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/workspaces/{projectId}/customize/channels',
    requiresProject: true,
    keywords:
      'channels slack email agent mail agentmail agentic mail inbox messaging notifications connections project customize',
  },
  {
    id: 'proj-settings',
    label: 'Project settings',
    icon: CogOneSolid,
    group: 'navigation',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/workspaces/{projectId}/customize/settings',
    requiresProject: true,
    keywords: 'project settings repository general danger zone',
  },

  // ──────────────────────────────────────────────────────────────────────────
  // QUICK ACTIONS (right sidebar top section)
  // ──────────────────────────────────────────────────────────────────────────
  {
    id: 'files-quick',
    label: 'Files',
    icon: FolderOpen,
    group: 'quickActions',
    subGroup: 'tools',
    showIn: ['rightSidebar'],
    kind: 'navigate',
    href: '/files',
    tabId: 'page:/files',
  },
  {
    id: 'new-terminal',
    label: 'Terminal',
    icon: TerminalSquare,
    group: 'quickActions',
    subGroup: 'tools',
    showIn: ['rightSidebar'],
    kind: 'action',
    actionId: 'newTerminal',
  },
  {
    id: 'workspace',
    label: 'Workspace',
    icon: Blocks,
    group: 'quickActions',
    subGroup: 'tools',
    showIn: ['commandPalette', 'rightSidebar'],
    kind: 'navigate',
    href: '/workspace',
    activePathPrefixes: ['/workspace', '/agents', '/commands', '/tools'],
    keywords: 'workspace agents skills commands tools build create',
  },
  {
    id: 'providers-quick',
    label: 'LLM Providers',
    icon: Bot,
    group: 'quickActions',
    subGroup: 'security',
    showIn: ['rightSidebar'],
    kind: 'action',
    actionId: 'openProviderModal',
  },

  // ──────────────────────────────────────────────────────────────────────────
  // NAVIGATION — Main pages
  // ──────────────────────────────────────────────────────────────────────────
  {
    id: 'dashboard',
    label: 'Dashboard',
    icon: LayoutDashboard,
    group: 'navigation',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/dashboard',
    tabType: 'dashboard',
  },
  {
    id: 'scheduled-tasks',
    label: 'Triggers',
    icon: Calendar,
    group: 'navigation',
    subGroup: 'services',
    showIn: ['commandPalette', 'rightSidebar'],
    kind: 'navigate',
    href: '/scheduled-tasks',
  },
  {
    id: 'running-services',
    label: 'Service Manager',
    icon: Activity,
    group: 'navigation',
    subGroup: 'services',
    showIn: ['rightSidebar'],
    kind: 'navigate',
    href: '/service-manager',
    tabId: 'service-manager',
    tabType: 'services',
  },
  {
    id: 'internal-browser',
    label: 'Internal Browser',
    icon: Compass,
    group: 'navigation',
    subGroup: 'services',
    showIn: ['rightSidebar'],
    kind: 'navigate',
    href: '/p/browser',
    tabId: 'preview:internal-browser',
    tabType: 'preview',
  },
  {
    id: 'agent-browser',
    label: 'Agent Browser',
    icon: Globe,
    group: 'navigation',
    subGroup: 'services',
    showIn: ['rightSidebar'],
    kind: 'navigate',
    href: '/browser',
    tabId: 'browser:main',
    tabType: 'browser',
  },
  {
    id: 'desktop',
    label: 'Desktop',
    icon: MonitorIcon,
    group: 'navigation',
    subGroup: 'services',
    showIn: ['rightSidebar'],
    kind: 'navigate',
    href: '/desktop',
    tabId: 'desktop:main',
    tabType: 'desktop',
  },
  {
    id: 'files',
    label: 'Files',
    icon: FolderOpen,
    group: 'navigation',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/files',
  },
  {
    id: 'running-services-cmd',
    label: 'Service Manager',
    icon: Activity,
    group: 'navigation',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/service-manager',
    tabId: 'service-manager',
    tabType: 'services',
    keywords:
      'service manager services orchestration process manager sandbox active restart reload',
  },
  {
    id: 'agent-browser-cmd',
    label: 'Agent Browser',
    icon: Globe,
    group: 'navigation',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/browser',
    tabId: 'browser:main',
    tabType: 'browser',
    keywords: 'browser chromium agent viewport automation live stream',
  },
  {
    id: 'internal-browser-cmd',
    label: 'Internal Browser',
    icon: Compass,
    group: 'navigation',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/p/browser',
    tabId: 'preview:internal-browser',
    tabType: 'preview',
    keywords: 'internal browser preview iframe embedded web page',
  },
  {
    id: 'desktop-cmd',
    label: 'Desktop',
    icon: MonitorIcon,
    group: 'navigation',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/desktop',
    tabId: 'desktop:main',
    tabType: 'desktop',
    keywords: 'desktop selkies novnc full screen xfce sandbox vnc remote',
  },
  {
    id: 'changelog',
    label: 'Changelog',
    icon: ScrollText,
    group: 'navigation',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/changelog',
  },
  {
    id: 'credits-explained',
    label: 'Credits Explained',
    icon: Coins,
    group: 'navigation',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/help/credits',
    keywords: 'credits coins billing usage tokens cost explain',
  },

  // ──────────────────────────────────────────────────────────────────────────
  // SETTINGS PAGES (navigate to route)
  // ──────────────────────────────────────────────────────────────────────────
  {
    id: 'llm-providers',
    label: 'LLM Providers',
    icon: Bot,
    group: 'settingsPages',
    showIn: ['commandPalette'],
    kind: 'action',
    actionId: 'openProviderModal',
    keywords: 'llm providers models anthropic openai openrouter google groq xai',
  },
  // ──────────────────────────────────────────────────────────────────────────
  // PREFERENCES — open settings modal to a tab
  // ──────────────────────────────────────────────────────────────────────────
  {
    id: 'pref-general',
    label: 'General',
    icon: CogOne,
    group: 'preferences',
    showIn: ['commandPalette', 'userMenu'],
    kind: 'settings',
    settingsTab: 'general',
    keywords: 'settings preferences general profile name email language',
  },
  {
    id: 'pref-appearance',
    label: 'Appearance',
    icon: Palette,
    group: 'preferences',
    showIn: ['commandPalette'],
    kind: 'settings',
    settingsTab: 'appearance',
    keywords: 'appearance theme color mode wallpaper shader shaders background',
  },
  {
    id: 'pref-sounds',
    label: 'Sounds',
    icon: Volume2,
    group: 'preferences',
    showIn: ['commandPalette'],
    kind: 'settings',
    settingsTab: 'sounds',
    keywords: 'sounds audio volume notification sound effects mute',
  },

  {
    id: 'pref-shortcuts',
    label: 'Shortcuts',
    icon: Keyboard,
    group: 'preferences',
    showIn: ['commandPalette'],
    kind: 'settings',
    settingsTab: 'shortcuts',
    keywords: 'shortcuts keyboard hotkeys keybindings keys',
  },

  // ──────────────────────────────────────────────────────────────────────────
  // ACCOUNT — open settings modal to billing-related tabs
  // ──────────────────────────────────────────────────────────────────────────
  {
    id: 'account-billing',
    label: 'Billing',
    icon: CreditCardSolid,
    group: 'account',
    showIn: ['commandPalette', 'userMenu'],
    kind: 'settings',
    settingsTab: 'billing',
    keywords:
      'billing payment credit card subscription manage wallet tier plan limits overview spend usage',
    requiresBilling: true,
  },
  {
    id: 'account-transactions',
    label: 'Credits ledger',
    icon: Receipt,
    group: 'account',
    showIn: ['commandPalette'],
    kind: 'settings',
    settingsTab: 'transactions',
    keywords: 'credits ledger transactions history purchases receipts',
  },
  {
    id: 'account-referrals',
    label: 'Referrals',
    icon: UsersSolid,
    group: 'account',
    showIn: ['commandPalette'],
    kind: 'settings',
    settingsTab: 'referrals',
    keywords: 'referrals invite share friends earn',
    requiresBilling: true,
  },
  {
    id: 'account-tokens',
    label: 'API keys',
    icon: KeyRound,
    group: 'account',
    showIn: ['commandPalette', 'userMenu'],
    kind: 'settings',
    settingsTab: 'tokens',
    keywords: 'api keys tokens personal access pat cli command line authentication',
  },

  // ──────────────────────────────────────────────────────────────────────────
  // THEME
  // ──────────────────────────────────────────────────────────────────────────
  {
    id: 'theme-light',
    label: 'Light Theme',
    icon: Sun,
    group: 'theme',
    showIn: ['commandPalette'],
    kind: 'theme',
    themeValue: 'light',
    keywords: 'theme light mode bright day',
  },
  {
    id: 'theme-dark',
    label: 'Dark Theme',
    icon: Moon,
    group: 'theme',
    showIn: ['commandPalette'],
    kind: 'theme',
    themeValue: 'dark',
    keywords: 'theme dark mode night',
  },
  {
    id: 'theme-system',
    label: 'System Theme',
    icon: MonitorIcon,
    group: 'theme',
    showIn: ['commandPalette'],
    kind: 'theme',
    themeValue: 'system',
    keywords: 'theme system auto default os',
  },

  // ──────────────────────────────────────────────────────────────────────────
  // WALLPAPERS — derived from the appearance-tab list; typing a wallpaper's
  // name (Dither, Grain, Silk, …) in the palette applies it directly.
  // ──────────────────────────────────────────────────────────────────────────
  ...WALLPAPERS.map((wp): MenuItemDef => ({
    id: `wallpaper-${wp.id}`,
    label: `Appearance · ${wp.name}`,
    icon: WallpaperIcon,
    group: 'wallpaper',
    showIn: ['commandPalette'],
    kind: 'wallpaper',
    wallpaperValue: wp.id,
    keywords: `wallpaper wallpapers background appearance ${wp.id}${
      wp.type === 'shader' ? ' shader shaders animated' : ''
    }`,
  })),

  // ──────────────────────────────────────────────────────────────────────────
  // VIEW
  // ──────────────────────────────────────────────────────────────────────────
  {
    id: 'toggle-sidebar',
    label: 'Toggle Sidebar',
    icon: PanelLeftClose, // swapped dynamically at render time
    group: 'view',
    showIn: ['commandPalette'],
    kind: 'action',
    actionId: 'toggleSidebar',
    shortcut: 'Ctrl+B',
  },
  {
    id: 'toggle-panel-mode',
    label: 'Switch to Advanced View', // swapped dynamically at render time based on current mode
    icon: SlidersHorizontal,
    group: 'view',
    showIn: ['commandPalette'],
    kind: 'action',
    actionId: 'togglePanelMode',
    keywords: 'easy advanced simple panel session detail mode view',
    requiresSession: true,
  },
  {
    id: 'logout',
    label: 'Log Out',
    icon: LogOut,
    group: 'view',
    showIn: ['commandPalette', 'userMenu'],
    kind: 'action',
    actionId: 'logout',
    keywords: 'log out sign out logout signout disconnect',
  },
];

// ============================================================================
// Selectors — filter the registry for each surface
// ============================================================================

export function getItemsForSurface(surface: MenuSurface): MenuItemDef[] {
  return menuRegistry.filter((item) => item.showIn.includes(surface));
}

export function getItemsByGroup(surface: MenuSurface, group: MenuGroup): MenuItemDef[] {
  return menuRegistry.filter((item) => item.showIn.includes(surface) && item.group === group);
}

export function getItemById(id: string): MenuItemDef | undefined {
  return menuRegistry.find((item) => item.id === id);
}

/**
 * Returns navigation items for a surface, clustered by subGroup.
 * All items with the same subGroup are merged into a single cluster,
 * regardless of their ordering in the registry.
 * The cluster order follows the first appearance of each subGroup.
 * Items without a subGroup are placed in a leading "ungrouped" cluster.
 */
export function getNavItemsClustered(surface: MenuSurface, group: MenuGroup): MenuItemDef[][] {
  const items = getItemsByGroup(surface, group);
  const clusterMap = new Map<string, MenuItemDef[]>();
  const order: string[] = [];

  for (const item of items) {
    const key = item.subGroup ?? '__ungrouped__';
    if (!clusterMap.has(key)) {
      clusterMap.set(key, []);
      order.push(key);
    }
    clusterMap.get(key)!.push(item);
  }

  return order.map((key) => clusterMap.get(key)!);
}

/**
 * Returns whether a navigation item is currently "active" based on the pathname.
 */
export function isItemActive(item: MenuItemDef, pathname: string | null): boolean {
  if (!pathname || !item.href) return false;
  if (pathname === item.href) return true;
  if (item.activePathPrefixes) {
    return item.activePathPrefixes.some((prefix) => pathname.startsWith(prefix));
  }
  return false;
}

// ============================================================================
// Settings modal tabs — derived from the same registry
// ============================================================================

export interface SettingsTab {
  id: SettingsTabId;
  label: string;
  icon: ComponentType<{ className?: string }>;
}

/** Preference tabs for the settings modal */
export function getPreferenceTabs(): SettingsTab[] {
  const preferenceIds: SettingsTabId[] = ['general', 'appearance', 'sounds', 'shortcuts'];
  return preferenceIds.map((tabId) => {
    const item = menuRegistry.find((i) => i.kind === 'settings' && i.settingsTab === tabId);
    if (!item) {
      // Fallback — should not happen if registry is complete
      return { id: tabId, label: tabId, icon: CogOne };
    }
    return { id: tabId, label: item.label, icon: item.icon };
  });
}

/**
 * Instance-scoped tabs. Only injected into the settings modal when the
 * current route is inside an instance (`/instances/:id/...`). Returns an
 * empty array otherwise so the "Instance" section disappears entirely
 * on `/instances` list or account-level pages.
 */
export function getInstanceTabs(): SettingsTab[] {
  return [{ id: 'instance-members', label: 'Team', icon: UsersSolid }];
}

/** Account tabs for the settings modal */
export function getAccountTabs(billingEnabled: boolean): SettingsTab[] {
  const items: SettingsTab[] = [
    { id: 'billing', label: 'Billing', icon: CreditCardSolid },
    { id: 'transactions', label: 'Credits ledger', icon: Receipt },
    { id: 'tokens', label: 'API keys', icon: KeyRound },
  ];
  // Referrals tab disabled for now
  // if (billingEnabled) {
  //   items.push({ id: 'referrals', label: 'Referrals', icon: Users });
  // }
  // Enrich labels/icons from registry where possible
  return items.map((tab) => {
    const item = menuRegistry.find((i) => i.settingsTab === tab.id);
    if (item) {
      return { ...tab, label: item.label, icon: item.icon };
    }
    return tab;
  });
}

/** Theme options (used in user menu & command palette) */
export const themeOptions = menuRegistry
  .filter((item) => item.group === 'theme')
  .map((item) => ({
    value: item.themeValue!,
    icon: item.icon,
    label: item.label,
  }));

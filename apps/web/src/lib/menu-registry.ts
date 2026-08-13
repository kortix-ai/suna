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
import { PROJECT_LANDING_PATH } from '@/lib/onboarding/landing-destination';
import { WALLPAPERS } from '@/lib/wallpapers';
import type { FeatureFlagKey } from '@kortix/sdk';
import {
  ActivityIcon as Activity,
  SquaresFourIcon as Blocks,
  RobotIcon as Bot,
  CalendarIcon as Calendar,
  GearSixIcon as CogOne,
  CoinsIcon as Coins,
  CompassIcon as Compass,
  CreditCardIcon as CreditCardSolid,
  GitBranchIcon as FolderGit2,
  FolderOpenIcon as FolderOpen,
  GitDiffIcon as GitCompareArrows,
  GlobeIcon as Globe,
  KeyIcon as KeyRound,
  StackIcon as Layers,
  SquaresFourIcon as LayoutDashboard,
  SignOutIcon as LogOut,
  ChatsIcon as MessagesSquare,
  SidebarSimpleIcon as PanelLeftClose,
  PlugIcon as Plug,
  PlusIcon as Plus,
  ArrowClockwiseIcon as RefreshCw,
  ScrollIcon as ScrollText,
  MagnifyingGlassIcon as Search,
  ShieldCheckIcon as ShieldCheck,
  SlidersHorizontalIcon as SlidersHorizontal,
  TextAlignLeftIcon as TextAlignLeft,
  TerminalWindowIcon as Terminal,
  TerminalWindowIcon as TerminalSquare,
  UserPlusIcon as UserPlus,
  UsersIcon as UsersSolid,
  ImagesSquareIcon as WallpaperIcon,
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
  | 'shortcuts';

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
  /**
   * Extra search keywords for the command palette.
   *
   * This plus `label` is the WHOLE searchable text of a palette row — `id` and
   * `group` are deliberately NOT searchable, because a user has never seen
   * `nav-accounts` or `preferences` and cannot mean them. See
   * `buildPaletteSearchText` in `features/workspace/command-palette.tsx`.
   *
   * A word belongs here only when it NAMES THIS ROW: a synonym, an alias, or
   * something this row itself contains. A word that names a neighbouring
   * row's subject is a defect — it answers a query this row is the wrong
   * answer to. `command-palette-search.test.ts` pins the known instances.
   */
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
  /** If set, the item is only shown when the named per-project FEATURE FLAG is
   *  enabled (mirrors the Customize rail gating). A disabled feature's surface
   *  is invisible, so EVERY registry consumer must honour this — the command
   *  palette and the right sidebar both filter on it, fail-closed while the
   *  project detail is unresolved. */
  requiresFlag?: FeatureFlagKey;
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
    // 'agents skills commands' removed for the same reason they were removed
    // from `proj-customize` below: they name the Agents, Skills and Connectors
    // destinations. This row restarts the process that READS those files; a
    // user typing "skills" wants the Skills page, never a restart.
    keywords: 'reload restart config',
    requiresSession: true,
  },
  {
    id: 'sync-session-branch',
    label: 'Ask Agent: Sync Branch & Reload',
    icon: RefreshCw,
    group: 'actions',
    showIn: ['commandPalette'],
    kind: 'action',
    actionId: 'reconcileSession',
    keywords:
      'agent sync branch base pull merge conflict resolve reconcile reload restart refresh workspace',
    requiresSession: true,
  },

  // ──────────────────────────────────────────────────────────────────────────
  // PROJECT & APP NAVIGATION (command palette — new project shell)
  // App-level items always show; project-level items use the {projectId} token
  // and only show when a project is active (requiresProject).
  // ──────────────────────────────────────────────────────────────────────────
  {
    id: 'nav-projects',
    label: 'Projects',
    icon: FolderGit2,
    group: 'navigation',
    showIn: ['commandPalette'],
    kind: 'navigate',
    // Static registry entry — no user id to resolve the latest project with,
    // so this is the id-free landing door, never the removed `/projects`
    // list.
    href: PROJECT_LANDING_PATH,
    keywords: 'projects list all workspaces switch',
  },
  {
    id: 'nav-accounts',
    label: 'Accounts',
    icon: UsersSolid,
    group: 'navigation',
    showIn: ['commandPalette'],
    kind: 'navigate',
    // Selecting this in the palette opens the in-palette account switcher
    // (`SUBMENU_PAGE_BY_ID` in command-palette.tsx), so this href is the routed
    // fallback for any surface that consumes the registry without that picker —
    // same arrangement as `proj-sessions` below.
    //
    // It used to be `/accounts`, the page JAY-505 deletes. The account-scoped
    // surfaces (Organization, Billing, Usage, Groups, Roles, Identity, Audit)
    // live in the settings panel now, and `/settings/*` mounts that panel
    // without a project. Note the fallback path changes shape as well as
    // destination: `handleRegistryItem` runs `resolveSettingsOverlayHref` first
    // (command-palette.tsx), so a `/settings/<tab>` href OPENS THE OVERLAY on
    // that tab in place rather than navigating away, which is what the
    // `/accounts` href used to do.
    href: '/settings/organization',
    // 'members' is deliberately absent. It names the SETTINGS MEMBERS TAB and
    // the 'proj-invite' action, not the account switcher, so typing "member"
    // used to return Accounts ahead of the two rows that actually answer it.
    // A keyword belongs on a row only when it names that row — a synonym, an
    // alias, or something the row itself contains. Words that name a
    // neighbouring row's subject are removed on sight.
    keywords: 'accounts teams organizations switch manage',
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
    href: '/projects/{projectId}/sessions',
    requiresProject: true,
    // 'project' dropped with the rest of the legacy "project customize" tail:
    // it names 'nav-projects', and carrying it here made a one-word query for
    // Projects return eight unrelated rows.
    keywords: 'sessions runs threads conversations open',
  },
  {
    id: 'proj-customize',
    label: 'Customize',
    icon: SlidersHorizontal,
    group: 'navigation',
    showIn: ['commandPalette'],
    kind: 'navigate',
    // Names a tab. The bare `/projects/{projectId}/settings` this used to
    // carry resolved to `{ tab: undefined }` (resolveSettingsOverlayHref),
    // which `openSettings` reads as "keep whatever was last open" — so the
    // one entry labelled "Customize" landed somewhere different on every
    // click. `general` is the project workspace tab and survives every flag,
    // matching `DEFAULT_SETTINGS_TAB`.
    href: '/projects/{projectId}/settings/general',
    requiresProject: true,
    // 'agents' and 'skills' were deliberately dropped: both graduated out of
    // the overlay into their own palette entries (proj-agents, proj-skills).
    // Keeping the words here made this bare Customize entry match those
    // queries too and — since filteredNavItems preserves registry declaration
    // order rather than ranking by relevance — it listed ahead of the real
    // Agents/Skills entries. 'commands' is dropped for a different reason:
    // the Instructions tab that hosted them no longer exists, so there is
    // nothing for the query to lead to. 'project settings' went the same way
    // when the per-tab entries moved to `settings-palette-items.ts`: the
    // derived Workspace › General row carries those words now, and leaving
    // them here would list this generic door ahead of the named tab.
    //
    // The inverse leak has been closed too: five sibling rows (proj-agents,
    // proj-skills, proj-connectors, proj-connectors-policies, proj-invite)
    // used to end in the legacy tail 'project customize', so "customize"
    // returned six rows. Only this one, whose LABEL is Customize, keeps the
    // word here; on the settings side only the Workspace General tab keeps it,
    // which is where this row's href lands.
    keywords: 'customize configure',
  },
  {
    id: 'proj-files',
    label: 'Files',
    icon: FolderOpen,
    group: 'navigation',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/projects/{projectId}/files',
    requiresProject: true,
    keywords: 'files repository drive browser explorer',
  },
  {
    id: 'proj-apps',
    label: 'Apps',
    icon: Globe,
    group: 'navigation',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/projects/{projectId}/apps',
    requiresProject: true,
    requiresFlag: 'apps',
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
    // `legacySectionRedirect` bounces it here — but routing through the
    // redirect costs a second navigation and paints the overlay route first.
    href: '/projects/{projectId}/agent',
    requiresProject: true,
    keywords: 'agents subagents ai',
  },
  {
    id: 'proj-skills',
    label: 'Skills',
    icon: Blocks,
    group: 'navigation',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/projects/{projectId}/skills',
    requiresProject: true,
    keywords: 'skills abilities',
  },
  {
    id: 'proj-connectors',
    label: 'Connectors',
    icon: Plug,
    group: 'navigation',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/projects/{projectId}/connectors',
    requiresProject: true,
    // 'apps' removed: it is the label of `proj-apps` (deployments), so the
    // one-word query for that page returned Connectors as well. 'connector' /
    // 'connectors' / 'connections' still cover everything this row is called.
    keywords: 'connectors connections pipedream mcp openapi postman collections connector',
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
    href: '/projects/{projectId}/connectors',
    requiresProject: true,
    keywords: 'policies approval block require_approval rules tools connector guardrails',
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
    keywords: 'invite members add teammate email collaborator people access send',
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
  // PREFERENCES / ACCOUNT — `kind: 'settings'`, userMenu only.
  //
  // THE COMMAND PALETTE NO LONGER TAKES ITS SETTINGS DESTINATIONS FROM HERE.
  // Every settings tab is derived from `railGroups()` by
  // `features/workspace/settings-palette-items.ts` — the same single source
  // the rail and the pane headings read. Twelve `proj-*` entries and four
  // `kind: 'settings'` entries were removed with that change; four more lost
  // only their `'commandPalette'` surface. Do not re-add a settings
  // destination here: it will double-list against the derived row, and a
  // hand-written list is what let nine tabs ship with no palette entry at all.
  //
  // `pref-appearance`, `pref-sounds`, `pref-shortcuts` (all superseded by the
  // derived `preferences` row) and `account-transactions` (superseded by
  // `usage`) declared no surface other than the palette and are gone
  // entirely. `LEGACY_SETTINGS_TAB_MAP` still maps their `SettingsTabId`s,
  // which is what the three below rely on.
  //
  // `account-referrals` is gone for a different reason: `referrals` is not a
  // member of `SettingsTab` at all, so it fell through to `general` — a
  // mislabelled destination. Its only live surface, `ReferralModal`, mounts
  // inside `UserMenu` -> `AppHeader`, i.e. only under `/accounts/**`, and
  // nothing calls `useReferralDialog().openDialog()`. Pointing a palette
  // entry at it would reproduce the "store with no renderer" defect this
  // change exists to remove.
  // ──────────────────────────────────────────────────────────────────────────
  {
    id: 'pref-general',
    label: 'General',
    icon: CogOne,
    group: 'preferences',
    showIn: ['userMenu'],
    kind: 'settings',
    settingsTab: 'general',
    // 'profile name email' left with the palette surface: they name the USER
    // profile, and `settingsTab: 'general'` is the project WORKSPACE tab.
    // The derived `profile` row carries them now.
    keywords: 'settings preferences general language',
  },
  {
    id: 'account-billing',
    label: 'Billing',
    icon: CreditCardSolid,
    group: 'account',
    showIn: ['userMenu'],
    kind: 'settings',
    settingsTab: 'billing',
    keywords:
      'billing payment credit card subscription manage wallet tier plan limits overview spend usage',
    requiresBilling: true,
  },
  {
    id: 'account-tokens',
    label: 'API keys',
    icon: KeyRound,
    group: 'account',
    showIn: ['userMenu'],
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
    // A door, not a toggle: the palette maps this id to its 'density'
    // submenu page (SUBMENU_PAGE_BY_ID in command-palette.tsx), where the
    // two modes are picked explicitly — same pattern as `nav-accounts`.
    id: 'conversation-density',
    label: 'Conversation Density',
    icon: TextAlignLeft,
    group: 'view',
    showIn: ['commandPalette'],
    kind: 'action',
    actionId: 'conversationDensity',
    keywords:
      'density conversation verbosity compact minimal normal quiet activity thinking text detail steps working burst',
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

/**
 * The `SettingsTab` interface and its three builders (`getPreferenceTabs`,
 * `getInstanceTabs`, `getAccountTabs`) lived here until the merged settings
 * panel landed. Their only consumer was `SidePanelUserSettings`, deleted with
 * the modal it drove; `settings/rail.ts` now owns the rail's own vocabulary.
 * `SettingsTabId` itself stays — the command palette's
 * `LEGACY_SETTINGS_TAB_MAP` and both modal stores still speak it.
 */

/** Theme options (used in user menu & command palette) */
export const themeOptions = menuRegistry
  .filter((item) => item.group === 'theme')
  .map((item) => ({
    value: item.themeValue!,
    icon: item.icon,
    label: item.label,
  }));

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
  AlarmIcon as AlarmClock,
  ArrowCircleUpIcon as ArrowUpCircle,
  SquaresFourIcon as Blocks,
  RobotIcon as Bot,
  CalendarIcon as Calendar,
  ChatCircleIcon as ChatCircle,
  GearSixIcon as CogOne,
  CoinsIcon as Coins,
  CompassIcon as Compass,
  ShippingContainerIcon as Container,
  CpuIcon as Cpu,
  CreditCardIcon as CreditCardSolid,
  FlaskIcon as Flask,
  GitBranchIcon as FolderGit2,
  FolderOpenIcon as FolderOpen,
  GitDiffIcon as GitCompareArrows,
  GlobeIcon as Globe,
  KeyIcon as KeyRound,
  StackIcon as Layers,
  SquaresFourIcon as LayoutDashboard,
  LifebuoyIcon as Lifebuoy,
  LockKeyIcon as LockKey,
  SignOutIcon as LogOut,
  ChatsIcon as MessagesSquare,
  PaintBrushIcon as PaintBrush,
  SidebarSimpleIcon as PanelLeftClose,
  PlugIcon as Plug,
  PlusIcon as Plus,
  QuestionIcon as QuestionMark,
  ArrowClockwiseIcon as RefreshCw,
  ScrollIcon as ScrollText,
  MagnifyingGlassIcon as Search,
  ShieldCheckIcon as ShieldCheck,
  SlidersHorizontalIcon as SlidersHorizontal,
  TerminalIcon as Terminal,
  TextAlignLeftIcon as TextAlignLeft,
  TrayIcon as Tray,
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
    icon: Terminal,
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
  {
    id: 'review-changes',
    label: 'Review changes',
    icon: GitCompareArrows,
    group: 'actions',
    showIn: ['commandPalette'],
    kind: 'action',
    // Opens the in-palette list of OPEN change requests
    // (`SUBMENU_PAGE_BY_ID` -> the 'changes' page), the same set the sidebar's
    // green "Review changes" pill lists in its popover, and picking one opens
    // that CR's detail dialog. The pill is the only surface that offered them
    // and it hides itself at zero — so with the sidebar collapsed, or with no
    // open CR yet, there was no way to ask "what is waiting on me?" at all.
    //
    // `requiresProject`, not `requiresSession`: a change request belongs to
    // the workspace, not to the session that produced it.
    actionId: 'reviewChanges',
    requiresProject: true,
    keywords:
      'review changes change requests cr diff pull request merge open pending approve waiting',
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
    // "Switch workspace", not "Projects". The product retired the noun
    // (`features/workspace/workspace-vocabulary.test.ts`) everywhere except
    // here, so the palette was the one surface still answering a question the
    // rest of the app had stopped asking — and a bare noun does not say the
    // row DOES anything, which is why it read as a list rather than as the
    // switcher it opens.
    label: 'Switch workspace',
    icon: FolderGit2,
    group: 'navigation',
    showIn: ['commandPalette'],
    kind: 'navigate',
    // Static registry entry — no user id to resolve the latest project with,
    // so this is the id-free landing door, never the removed `/projects`
    // list. Selecting the row normally opens the in-palette switcher
    // (`SUBMENU_PAGE_BY_ID` in command-palette.tsx); this href is the routed
    // fallback if that map ever loses the id.
    href: PROJECT_LANDING_PATH,
    shortcut: 'Ctrl+O',
    // `project`/`projects` stay in the bag deliberately. It is the word the
    // product used until recently, the word the URL still uses
    // (`/projects/<id>`), and the word anyone arriving from the API or the
    // CLI will type. Dropping it would make the rename cost users a search.
    keywords: 'switch workspace workspaces project projects change move open all list',
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
    // Back to `/accounts`, the account picker. It pointed at
    // `/settings/organization` while the account-scoped surfaces
    // (Organization, Billing, Usage, Groups, Roles, Identity, Audit, API keys)
    // lived in the project settings overlay. They do not: every one of them is
    // a section of `/accounts/[id]` again, reachable from the `account-*` rows
    // below, and `parseSettingsTab('organization')` now returns `null` — so
    // that href would have fallen through `resolveSettingsOverlayHref` to a
    // bare navigation at a route that renders no such tab.
    href: '/accounts',
    // 'members' is deliberately absent. It names the SETTINGS MEMBERS TAB and
    // the 'proj-invite' action, not the account switcher, so typing "member"
    // used to return Accounts ahead of the two rows that actually answer it.
    // A keyword belongs on a row only when it names that row — a synonym, an
    // alias, or something the row itself contains. Words that name a
    // neighbouring row's subject are removed on sight.
    keywords: 'accounts teams organizations switch manage',
  },
  {
    id: 'proj-home',
    label: 'Home',
    icon: Compass,
    group: 'navigation',
    showIn: ['commandPalette'],
    kind: 'navigate',
    // `/projects/<id>` — the workspace's own landing page (`ProjectHome`), the
    // composer plus the setup tiles. Every OTHER page under `/projects/<id>`
    // had a palette row and this one did not, so the only way back to it was
    // the sidebar's workspace name.
    href: '/projects/{projectId}',
    requiresProject: true,
    keywords: 'home overview landing start composer ask',
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
  // ──────────────────────────────────────────────────────────────────────────
  // CUSTOMIZE — one row per capability tab, one row per Settings section.
  //
  // This block used to be a SINGLE row (`proj-customize`, label "Settings")
  // whose keyword bag was the concatenated vocabulary of thirteen destinations:
  // "models llm gateway ... secrets env ... members team ... snapshots builds
  // ... voice call ... feature flags". One row for thirteen pages is why typing
  // "model" opened project Settings instead of the Models page — the only row
  // that owned the word went to `/config`, and the page that IS models had no
  // registry entry at all. Models, Secrets, Channels and Members had graduated
  // into their own routes months earlier (`capability-tab-routes.ts`) and never
  // got rows; the six `/config` sections were never separately addressable.
  //
  // Rule from here on: a destination the user can reach is a row. Where a
  // destination is a `?section=` of one page rather than a route of its own,
  // the row still exists — the query pre-selects the section, so the rows land
  // in different places and the "thirteen links to one URL" objection does not
  // apply. `menu-registry-destinations.test.ts` pins one row per
  // `CAPABILITY_TABS` key and one per `ProjectSettingsSectionKey`, so a new
  // tab or section cannot ship unreachable from ⌘K again.
  {
    id: 'proj-customize',
    label: 'Customize',
    icon: SlidersHorizontal,
    group: 'navigation',
    showIn: ['commandPalette'],
    kind: 'navigate',
    // `/customize` redirects to the first capability tab the caller may open
    // — Agents, for anyone who can read them — so this entry lands where the
    // sidebar's Customize row lands (Marko, 2026-09-01: Customize is
    // agent-centric). It is kept as the palette's href rather than `/agent`
    // so the two cannot drift: one redirect owns the landing rule.
    href: '/projects/{projectId}/customize',
    requiresProject: true,
    keywords: 'customize configure setup capabilities overview hub',
  },
  // The Customize bar's trailing Settings tab, one row per section. Retired
  // 2026-09-02 for the overlay's Workspace group; both came back to this page
  // on 2026-09-03 (Marko) when that group was removed from the overlay.
  {
    id: 'proj-config-general',
    label: 'Settings · General',
    icon: CogOne,
    group: 'navigation',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/projects/{projectId}/customize/settings',
    requiresProject: true,
    keywords:
      'settings general workspace rename delete danger zone name description git repo repository github clone branch remote',
  },
  {
    id: 'proj-config-sandbox',
    label: 'Settings · Sandbox templates',
    icon: Container,
    group: 'navigation',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/projects/{projectId}/customize/settings?section=sandbox',
    requiresProject: true,
    // Snapshots merged into this section — a snapshot is a sandbox template's
    // build history — so both vocabularies answer here.
    keywords: 'sandbox templates template image runtime machine snapshots builds recipe container',
  },
  {
    id: 'proj-config-feature-flags',
    label: 'Settings · Feature flags',
    icon: Flask,
    group: 'navigation',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/projects/{projectId}/customize/settings?section=feature-flags',
    requiresProject: true,
    keywords: 'feature flags flag experimental labs beta toggle enable disable',
  },
  {
    id: 'proj-config-upgrades',
    label: 'Settings · Upgrades',
    icon: ArrowUpCircle,
    group: 'navigation',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/projects/{projectId}/customize/settings?section=upgrades',
    requiresProject: true,
    keywords: 'upgrades upgrade migrate migration manifest runner kortix yaml version bump',
  },
  {
    id: 'proj-models',
    label: 'Models',
    icon: Cpu,
    group: 'navigation',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/projects/{projectId}/customize/models',
    requiresProject: true,
    // The reported bug's row. `llm gateway providers budgets anthropic openai
    // openrouter` came off `proj-customize`'s bag, where they pointed at
    // `/config`. 'catalog' is deliberately NOT here: it contains "log", and
    // `command-palette-search.test.ts` pins that an audit-log search does not
    // drag unrelated rows in.
    keywords:
      'models model llm gateway providers provider budgets limits anthropic openai openrouter claude gpt gemini reasoning byok',
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
    href: '/projects/{projectId}/customize/agents',
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
    href: '/projects/{projectId}/customize/skills',
    requiresProject: true,
    keywords: 'skills abilities',
  },
  // Agents and Skills are declared BEFORE Connectors here, unlike the tab bar
  // order in `CAPABILITY_TABS`. Declaration order is the palette's tie-break
  // (`filteredNavItems` maps in registry order), and the Channels row carries
  // the keyword `agentmail` — a product name it genuinely owns, but one that
  // contains the substring "agent". With Channels declared first, the query
  // "agent" listed it above the row that IS the Agents page. Ordering is free;
  // dropping a real synonym is not.
  {
    id: 'proj-connectors',
    label: 'Connectors',
    icon: Plug,
    group: 'navigation',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/projects/{projectId}/customize/connectors',
    requiresProject: true,
    // 'apps' removed: it is the label of `proj-apps` (deployments), so the
    // one-word query for that page returned Connectors as well. 'connector' /
    // 'connectors' / 'connections' still cover everything this row is called.
    keywords: 'connectors connections pipedream mcp openapi postman collections connector',
  },
  {
    id: 'proj-channels',
    label: 'Channels',
    icon: ChatCircle,
    group: 'navigation',
    showIn: ['commandPalette'],
    kind: 'navigate',
    // Channels is a SCOPE of the Connectors page, not a route
    // (`channelsHref` in `capability-tab-routes.ts`). The row exists anyway:
    // "slack" and "inbox" are words people type, and the scope query lands
    // them on the inbound half rather than the outbound one.
    // 'connections' stays off this bag — it names `proj-connectors`.
    href: '/projects/{projectId}/customize/connectors?scope=channels',
    requiresProject: true,
    keywords: 'channels channel slack teams discord email agentmail inbox inbound messaging',
  },
  {
    id: 'proj-connectors-policies',
    // Was "Customize · Connectors · Policies" — no longer accurate: this no
    // longer lives under Customize.
    label: 'Connectors · Policies',
    icon: Plug,
    group: 'navigation',
    showIn: ['commandPalette'],
    kind: 'navigate',
    // `?rules=1` opens the Global rules sheet on arrival — the Connectors page
    // hosts `PoliciesPanel` and reads that param (`connectors-page.tsx`), so
    // this entry now reaches the destination its label names.
    href: '/projects/{projectId}/customize/connectors?rules=1',
    requiresProject: true,
    keywords: 'policies approval block require_approval rules tools connector guardrails',
  },
  {
    id: 'proj-triggers',
    label: 'Triggers',
    icon: AlarmClock,
    group: 'navigation',
    showIn: ['commandPalette'],
    kind: 'navigate',
    // Schedules and Webhooks merged into one Triggers capability page,
    // alongside Connectors / Agents / Skills — a trigger is one resource with
    // two ways to start it, not two separate rows. `/projects/{id}/settings/
    // schedules` and `/settings/webhooks` no longer resolve to a tab; both
    // redirect here via `legacySectionRedirect`.
    href: '/projects/{projectId}/customize/triggers',
    requiresProject: true,
    // The combined bag both retired rows carried, so neither query goes dark.
    keywords:
      'schedules schedule cron scheduled tasks webhooks webhook http endpoint incoming request triggers timed recurring',
  },
  {
    id: 'proj-secrets',
    label: 'Secrets',
    icon: LockKey,
    group: 'navigation',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/projects/{projectId}/customize/secrets',
    requiresProject: true,
    keywords: 'secrets secret env environment variables credentials vault egress store',
  },
  {
    id: 'proj-members',
    label: 'Workspace members',
    icon: UsersSolid,
    group: 'navigation',
    showIn: ['commandPalette'],
    kind: 'action',
    // An ACTION, not a navigate row: the destination is the OWNING account's
    // Access pane scoped back to this workspace
    // (`/accounts/<acct>?tab=access-projects&project=<id>`), and the account
    // id is a field on the project detail — a network read the registry
    // cannot do. `openProjectMembers` in command-palette.tsx resolves it, the
    // same way `inviteMembers` does. `/projects/<id>/members` still resolves
    // and redirects to the same place, but routing through it costs a second
    // navigation and paints the capabilities shell first.
    actionId: 'openProjectMembers',
    requiresProject: true,
    // The roster half. 'invite' belongs to `proj-invite`, the verb row.
    keywords:
      'members member workspace access collaborators people teammates roster who can see permissions grant share seats',
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
  // `proj-config-general`, `proj-config-sandbox`, `proj-config-feature-flags`
  // are gone with `/projects/<id>/config` (retired 2026-09-02). General,
  // Sandbox templates, Feature flags and Upgrades are Settings-overlay tabs
  // now, and the palette derives those rows from the overlay's rail
  // (`settings-palette-items.ts`) — a registry href would be a second,
  // drifting copy. Feature flags' in-palette picker moved with it: see
  // `SETTINGS_TAB_SUBMENU_PAGE` in `command-palette.tsx`.
  //
  // `proj-config-feature-flags` outlived that sentence by a day. The row was
  // still here on 2026-09-03, twenty-five lines under its own obituary, with
  // `href: '/projects/{projectId}/customize/settings?section=feature-flags'` — a route
  // `app/` no longer contains. Typing "feature flag" returned TWO rows: this
  // one, under Navigation, labelled "Settings · Feature flags" and landing on
  // a dead URL, and the derived `settings-tab-feature-flags` under "Settings ·
  // Workspace", which opens the in-palette picker correctly. The dead one read
  // like the right answer.
  //
  // Nothing was lost with it. Its keyword bag (`feature flags experimental
  // beta labs toggles switches early access`) is a strict subset of the
  // `feature-flags` bag in `settings-palette-items.ts`, and the picker it
  // claimed to open was never keyed to its id — `SUBMENU_PAGE_BY_ID` has no
  // `proj-config-feature-flags` entry, which is exactly why the row navigated.
  //
  // `menu-registry-destinations.test.ts` now checks the other direction too:
  // every `kind: 'navigate'` href must resolve to a real route under
  // `src/app`. A route deleted out from under a palette row is a red test now,
  // not a dead link nobody notices.
  {
    // Not `proj-review` — that id named the old overlay tab and its absence
    // is pinned (`command-palette.test.tsx`); this row is the capability page.
    id: 'proj-review-inbox',
    label: 'Review',
    icon: Tray,
    group: 'navigation',
    showIn: ['commandPalette'],
    kind: 'navigate',
    // Its own capability tab since 2026-09-02, beside Agents and Triggers.
    href: '/projects/{projectId}/customize/review',
    requiresProject: true,
    // Same gate the tab carries (`visibleCapabilityTabs` hides Review while
    // `review_center` is off), so the row cannot outlive the page.
    requiresFlag: 'review_center',
    keywords: 'review center inbox approvals awaiting waiting needs you outputs queue',
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
    icon: Terminal,
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
    label: 'Credits & usage',
    icon: Coins,
    group: 'navigation',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/docs/credits',
    // `explained` stays in the keywords because /credits-explained was the
    // original public URL and is still what people type for this page.
    keywords: 'credits coins billing usage tokens cost explain explained',
  },
  {
    id: 'support',
    label: 'Support',
    icon: Lifebuoy,
    group: 'navigation',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/support',
    // "help" is the important one: this page absorbed /help, and that is still
    // the word people reach for. Deliberately NOT "account", "delete" or
    // "billing" — those queries belong to the account sections and the
    // delete-account action, and a support row answering them would push the
    // real destination down the list (command-palette-search.test.ts pins the
    // exact hit set for "account" for this reason).
    keywords: 'support help faq contact refund bug report issue question',
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
  // That rule is about SETTINGS TABS. The `account-*` rows below are not
  // settings tabs and cannot double-list: their destinations left the overlay
  // for `/accounts/[id]`, so `railGroups()` has no row to derive and a
  // hand-written row is the only way to reach them — same as `proj-triggers`.
  //
  // `pref-appearance`, `pref-sounds`, `pref-shortcuts` (all superseded by the
  // derived `preferences` row) and `account-transactions` (superseded by the
  // `account-usage` row below) declared no surface other than the palette and
  // are gone entirely.
  //
  // `account-referrals` is gone for a different reason: `referrals` is not a
  // member of `SettingsTab` at all, so it fell through to `general` — a
  // mislabelled destination. Its only live surface, `ReferralModal`, mounts
  // inside `UserMenu` -> `AppHeader`, i.e. only under `/accounts/**`, and
  // nothing calls `useReferralDialog().openDialog()`. Pointing a palette
  // entry at it would reproduce the "store with no renderer" defect this
  // change exists to remove.
  // ──────────────────────────────────────────────────────────────────────────
  // `pref-general` is gone. It declared `settingsTab: 'general'` — the project
  // WORKSPACE tab — which is a `?section=` on `/projects/[id]/customize/settings` now, not
  // a settings tab at all. A `kind: 'settings'` row can only name a tab, and
  // there is no user-scoped tab this row meant, so it was removed rather than
  // repointed at an unrelated pane. Nothing rendered it: its only declared
  // surface was `userMenu`, and `user-menu.tsx` builds its own rows.
  // ──────────────────────────────────────────────────────────────────────────
  // ACCOUNT SECTIONS — `/accounts/[id]`, NOT the project settings overlay.
  //
  // These eight rows are the palette's only route to the account-scoped
  // surfaces. They spent one release as settings tabs, derived from
  // `railGroups()` like every other tab; they are not settings tabs any more
  // (`ACCOUNT_GRADUATED` in `features/workspace/settings/settings-tabs.ts`
  // redirects every stale `/settings/<id>` bookmark onto this page), so the
  // derived list cannot produce them and they are hand-written here — the same
  // arrangement `proj-triggers` uses for the same reason.
  //
  // Each `href` carries the `{accountId}` token, resolved at render exactly
  // like `{projectId}`. A row whose href still holds an unresolved token is
  // DROPPED by the palette rather than navigated to — see `allPaletteItems` in
  // `features/workspace/command-palette.tsx`. Every keyword bag below is the
  // one its retired settings row carried, so no query that used to find these
  // destinations goes dark.
  // ──────────────────────────────────────────────────────────────────────────
  {
    id: 'account-general',
    // "Settings", not "General": the destination's own rail row and pane
    // heading both say Settings, and a palette row must not promise a name the
    // page does not use. `general` and `organization` stay in the keyword bag,
    // which is where the overlay-era names belong.
    label: 'Account · Settings',
    icon: CogOne,
    group: 'account',
    showIn: ['commandPalette'],
    kind: 'navigate',
    // It holds the account name, the MFA/session policy, the enterprise
    // preview, and deletion.
    href: '/accounts/{accountId}?tab=settings',
    keywords:
      'general organization org company name sign in rules teams manage security mfa danger zone rename delete',
  },
  {
    id: 'account-members',
    label: 'Account · Members',
    icon: UsersSolid,
    group: 'account',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/accounts/{accountId}?tab=members',
    // 'members' alone stays off this row: it names the project settings
    // Members tab, which is a different roster. These words name the ACCOUNT
    // roster specifically.
    keywords: 'account members organization roster owners admins seats',
  },
  {
    id: 'account-billing',
    label: 'Account · Billing',
    icon: CreditCardSolid,
    group: 'account',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/accounts/{accountId}?tab=billing',
    keywords:
      'billing payment credit card subscription manage wallet tier plan limits overview spend',
    requiresBilling: true,
  },
  {
    id: 'account-usage',
    label: 'Account · Usage',
    icon: Coins,
    group: 'account',
    showIn: ['commandPalette'],
    kind: 'navigate',
    // The account page calls this section `transactions`.
    href: '/accounts/{accountId}?tab=transactions',
    keywords: 'usage credits ledger transactions history purchases receipts spend consumption',
  },
  {
    id: 'account-access-projects',
    // The account page's Access rail calls this pane "Projects". The label
    // keeps that name and the `Account · ` prefix every sibling carries, so
    // the row promises exactly what the destination shows.
    //
    // This is the WORKSPACE-level roster, as distinct from `account-members`
    // above (the organization-level one): Members answers "who is in this
    // account", this answers "which workspaces can they open, and with what
    // agents". Both were reachable from the palette as one word — "members" —
    // which returned the organization list only. `proj-members` is the same
    // pane pre-scoped to the workspace you are standing in.
    label: 'Account · Projects',
    icon: FolderOpen,
    group: 'account',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/accounts/{accountId}?tab=access-projects',
    keywords: 'workspace access grants who can open repositories per workspace membership',
  },
  {
    id: 'account-git',
    label: 'Account · Git',
    icon: FolderGit2,
    group: 'account',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/accounts/{accountId}?tab=git',
    keywords: 'git github app installation repositories connect clone remote host provider',
  },
  {
    id: 'account-groups',
    label: 'Account · Groups',
    icon: UsersSolid,
    group: 'account',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/accounts/{accountId}?tab=groups',
    keywords: 'groups teams directory scim membership sets',
  },
  {
    id: 'account-roles',
    label: 'Account · Roles',
    icon: ShieldCheck,
    group: 'account',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/accounts/{accountId}?tab=roles',
    keywords: 'roles permissions access rbac policy custom role',
  },
  {
    id: 'account-identity',
    label: 'Account · Identity',
    icon: ShieldCheck,
    group: 'account',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/accounts/{accountId}?tab=identity',
    keywords: 'identity sso saml oidc scim login provider single sign on directory',
  },
  {
    id: 'account-branding',
    label: 'Account · Branding',
    icon: PaintBrush,
    group: 'account',
    showIn: ['commandPalette'],
    kind: 'navigate',
    // Enterprise `branding` entitlement pane (#6947). The row stays ungated
    // like its enterprise siblings (roles, identity): the pane itself explains
    // the entitlement.
    href: '/accounts/{accountId}?tab=branding',
    keywords:
      'branding logo icon favicon product name app name white label whitelabel theme identity',
  },
  {
    id: 'account-audit',
    label: 'Account · Audit log',
    icon: ScrollText,
    group: 'account',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/accounts/{accountId}?tab=audit',
    keywords: 'audit log logs events history trail compliance',
  },
  {
    id: 'account-help',
    label: 'Account · Permissions help',
    icon: QuestionMark,
    group: 'account',
    showIn: ['commandPalette'],
    kind: 'navigate',
    // The old `PermissionsHelpPopover`, promoted to a linkable pane. It is
    // reference copy — no data, no mutations — and is the only pane in the
    // Access rail nothing linked to from outside the page.
    href: '/accounts/{accountId}?tab=help',
    keywords: 'permissions help what does mean reference explain owner admin member viewer',
  },
  {
    id: 'account-tokens',
    label: 'Account · Service account tokens',
    icon: KeyRound,
    group: 'account',
    showIn: ['commandPalette'],
    kind: 'navigate',
    // The account page calls this section `tokens`, and since 2026-08-18 it
    // holds ONE kind of credential: a service account's — an automation's own
    // identity, which outlives whoever made it. A person's own API keys moved
    // to their settings (`settings:tokens`, derived from the rail), so the
    // words for those — `personal`, `pat`, `cli` — moved with them. Leaving
    // them here would make this row the answer to a query it is the wrong
    // answer to.
    href: '/accounts/{accountId}?tab=tokens',
    keywords:
      'service account tokens machine identity automation ci cd bot integration key rules expiry policy',
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

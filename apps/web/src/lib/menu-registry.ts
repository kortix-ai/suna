/**
 * ============================================================================
 * CENTRAL MENU REGISTRY — Single source of truth for all navigation items
 * ============================================================================
 *
 * Every menu item in the app lives here. The Command Palette (Cmd+K),
 * Left Sidebar, User Settings Menu, and Settings Modal all consume these
 * definitions — update once, synced everywhere.
 *
 * To add a new page / action:
 *   1. Add a lucide icon import below
 *   2. Add an entry to the appropriate section
 *   3. Done — it will appear in every surface that renders that section
 *
 * Each item declares which surfaces it should appear in via `showIn`.
 * Surfaces: 'commandPalette' | 'leftSidebar' | 'userMenu'
 * ============================================================================
 */

import type { LucideIcon } from 'lucide-react';
import {
  // Navigation
  Blocks,
  FolderOpen,
  Calendar,
  // Projects / app navigation (new project shell)
  FolderGit2,
  MessagesSquare,
  SlidersHorizontal,
  Webhook,
  Hash,

  // Actions
  Plus,
  TerminalSquare,
  Layers,
  GitCompareArrows,
  Search,
  RefreshCw,

  // Settings pages
  KeyRound,
  Plug,
  Settings as SettingsIcon,
  Bot,

  // Preferences
  Palette,
  Volume2,
  Keyboard,

  // Account
  CreditCard,
  Receipt,
  Users,

  // Theme
  Sun,
  Moon,
  Monitor,

  // View / Misc
  PanelLeftClose,
  LogOut,
} from 'lucide-react';

// ============================================================================
// Types
// ============================================================================

/** Where a menu item should be rendered. */
export type MenuSurface =
  | 'commandPalette'
  | 'leftSidebar'
  | 'userMenu';

/**
 * How the item behaves when activated.
 *
 * - 'navigate': Opens a route in a tab (uses openTabAndNavigate)
 * - 'action':   Runs an imperative callback (e.g. "new session", "logout")
 * - 'settings': Opens the UserSettingsModal to a specific tab
 * - 'theme':    Switches the app theme
 */
type MenuItemKind =
  | 'navigate'
  | 'action'
  | 'settings'
  | 'theme';

export type SettingsTabId =
  | 'general'
  | 'appearance'
  | 'sounds'
  | 'notifications'
  | 'billing'
  | 'transactions'
  | 'referrals'
  | 'tokens'
  | 'shortcuts'
  | 'instance-projects';

/** The group / section a menu item belongs to. */
type MenuGroup =
  | 'actions'
  | 'navigation'
  | 'settingsPages'
  | 'preferences'
  | 'account'
  | 'theme'
  | 'view'
  | 'admin';

export interface MenuItemDef {
  /** Unique identifier for this item (used as React key, cmdk value, etc.) */
  id: string;
  /** Display label */
  label: string;
  /** Lucide icon component */
  icon: LucideIcon;
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
  /** For kind='action': a string key identifying the action (resolved at runtime) */
  actionId?: string;

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
}

// ============================================================================
// Registry definitions
// ============================================================================

const menuRegistry: MenuItemDef[] = [
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
    label: 'Restart: Full',
    icon: RefreshCw,
    group: 'actions',
    showIn: ['commandPalette'],
    kind: 'action',
    actionId: 'restartFull',
    keywords: 'reload restart full services kill nuclear',
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
    href: '/projects',
    keywords: 'projects list all workspaces switch',
  },
  {
    id: 'nav-accounts',
    label: 'Accounts',
    icon: Users,
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
    // the href is only a non-palette fallback and points at the project root
    // (the session-list page was removed in favour of the composer landing).
    href: '/projects/{projectId}',
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
    href: '/projects/{projectId}/customize',
    requiresProject: true,
    keywords: 'customize configure project agents skills commands',
  },
  {
    id: 'proj-files',
    label: 'Customize · Files',
    icon: FolderOpen,
    group: 'navigation',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/projects/{projectId}/customize/files',
    requiresProject: true,
    keywords: 'files repository project customize browser explorer',
  },
  {
    id: 'proj-agents',
    label: 'Customize · Agents',
    icon: Bot,
    group: 'navigation',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/projects/{projectId}/customize/agents',
    requiresProject: true,
    keywords: 'agents subagents project customize ai',
  },
  {
    id: 'proj-skills',
    label: 'Customize · Skills',
    icon: Blocks,
    group: 'navigation',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/projects/{projectId}/customize/skills',
    requiresProject: true,
    keywords: 'skills project customize abilities',
  },
  {
    id: 'proj-commands',
    label: 'Customize · Commands',
    icon: TerminalSquare,
    group: 'navigation',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/projects/{projectId}/customize/commands',
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
    href: '/projects/{projectId}/customize/secrets',
    requiresProject: true,
    keywords: 'secrets env environment variables project customize',
  },
  {
    id: 'proj-connectors',
    label: 'Customize · Connectors',
    icon: Plug,
    group: 'navigation',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/projects/{projectId}/customize/connectors',
    requiresProject: true,
    keywords: 'connectors integrations pipedream mcp openapi apps executor project customize',
  },
  {
    id: 'proj-connectors-policies',
    label: 'Customize · Connectors · Policies',
    icon: Plug,
    group: 'navigation',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/projects/{projectId}/customize/connectors?tab=policies',
    requiresProject: true,
    keywords: 'policies approval block require_approval rules tools executor guardrails project customize',
  },
  {
    id: 'proj-members',
    label: 'Customize · Members',
    icon: Users,
    group: 'navigation',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/projects/{projectId}/customize/members',
    requiresProject: true,
    keywords: 'members team access collaborators project customize',
  },
  {
    id: 'proj-schedules',
    label: 'Customize · Schedules',
    icon: Calendar,
    group: 'navigation',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/projects/{projectId}/customize/schedules',
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
    href: '/projects/{projectId}/customize/webhooks',
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
    href: '/projects/{projectId}/customize/channels',
    requiresProject: true,
    keywords: 'channels slack integrations project customize',
  },
  {
    id: 'proj-settings',
    label: 'Project settings',
    icon: SettingsIcon,
    group: 'navigation',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/projects/{projectId}/customize/settings',
    requiresProject: true,
    keywords: 'project settings repository general danger zone',
  },

  // ──────────────────────────────────────────────────────────────────────────
  // PREFERENCES — open settings modal to a tab
  // ──────────────────────────────────────────────────────────────────────────
  {
    id: 'pref-general',
    label: 'General',
    icon: SettingsIcon,
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
    keywords: 'appearance theme color mode wallpaper',
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
    icon: CreditCard,
    group: 'account',
    showIn: ['commandPalette', 'userMenu'],
    kind: 'settings',
    settingsTab: 'billing',
    keywords: 'billing payment credit card subscription manage wallet tier plan limits overview spend usage',
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
    icon: Users,
    group: 'account',
    showIn: ['commandPalette'],
    kind: 'settings',
    settingsTab: 'referrals',
    keywords: 'referrals invite share friends earn',
    requiresBilling: true,
  },
  {
    id: 'account-tokens',
    label: 'CLI tokens',
    icon: KeyRound,
    group: 'account',
    showIn: ['commandPalette', 'userMenu'],
    kind: 'settings',
    settingsTab: 'tokens',
    keywords: 'cli tokens personal access pat command line authentication',
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
    icon: Monitor,
    group: 'theme',
    showIn: ['commandPalette'],
    kind: 'theme',
    themeValue: 'system',
    keywords: 'theme system auto default os',
  },

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

// ============================================================================
// Settings modal tabs — derived from the same registry
// ============================================================================

export interface SettingsTab {
  id: SettingsTabId;
  label: string;
  icon: LucideIcon;
}

/** Preference tabs for the settings modal */
export function getPreferenceTabs(): SettingsTab[] {
  const preferenceIds: SettingsTabId[] = ['general', 'appearance', 'sounds', 'shortcuts'];
  return preferenceIds.map((tabId) => {
    const item = menuRegistry.find(
      (i) => i.kind === 'settings' && i.settingsTab === tabId,
    );
    if (!item) {
      // Fallback — should not happen if registry is complete
      return { id: tabId, label: tabId, icon: SettingsIcon };
    }
    return { id: tabId, label: item.label, icon: item.icon };
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

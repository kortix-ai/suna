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

import type { LucideIcon } from 'lucide-react';
import {
  // Navigation
  LayoutDashboard,
  Blocks,
  FolderOpen,
  FolderKanban,
  Plug,
  MessageSquare,
  Calendar,
  ScrollText,
  Brain,
  Cable,
  Globe,
  Compass,
  Activity,
  Rocket,
  Sparkles,
  Coins,
  LayoutTemplate,

  // Actions
  Plus,
  TerminalSquare,
  Layers,
  GitCompareArrows,
  Search,
  RefreshCw,

  // Settings pages
  KeyRound,
  Settings as SettingsIcon,
  Key,
  Bot,

  // Preferences
  Palette,
  Volume2,
  Bell,
  Keyboard,

  // Account
  Zap,
  CreditCard,
  Receipt,
  Users,

  // Theme
  Sun,
  Moon,
  Monitor,

  // View / Misc
  PanelLeftClose,
  PanelLeftIcon,
  LogOut,

  // Admin
  BarChart3,
  AlertTriangle,
  Database,
  Server,
  TestTube,
  UserPlus,
  BarChart2,
  MessageCircle,
  Wrench,
  Gauge,
  ShieldCheck,
} from 'lucide-react';

const DEPLOYMENTS_ENABLED = process.env.NEXT_PUBLIC_KORTIX_DEPLOYMENTS_ENABLED === 'true';

// ============================================================================
// Types
// ============================================================================

/** Where a menu item should be rendered. */
export type MenuSurface =
  | 'commandPalette'
  | 'rightSidebar'
  | 'leftSidebar'
  | 'userMenu';

/**
 * How the item behaves when activated.
 *
 * - 'navigate': Opens a route in a tab (uses openTabAndNavigate)
 * - 'action':   Runs an imperative callback (e.g. "new session", "logout")
 * - 'settings': Opens the UserSettingsModal to a specific tab
 * - 'theme':    Switches the app theme
 * - 'sandboxService': Opens a sandbox service preview tab (needs special handler)
 */
export type MenuItemKind =
  | 'navigate'
  | 'action'
  | 'settings'
  | 'theme'
  | 'sandboxService';

export type SettingsTabId =
  | 'general'
  | 'appearance'
  | 'sounds'
  | 'notifications'
  | 'billing'
  | 'transactions'
  | 'referrals'
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
  | 'view'
  | 'admin';

/**
 * Optional sub-group within a group for visual clustering.
 * Used by the right sidebar to add separators between logical sections
 * without changing the overall group structure.
 */
export type NavSubGroup =
  | 'tools'
  | 'services'
  | 'security';

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
    activePathPrefixes: ['/workspace', '/agents', '/skills', '/commands', '/tools'],
    keywords: 'workspace agents skills commands tools build create',
  },
  {
    id: 'secrets-quick',
    label: 'Secrets Manager',
    icon: KeyRound,
    group: 'quickActions',
    subGroup: 'security',
    showIn: ['rightSidebar'],
    kind: 'navigate',
    href: '/settings/credentials',
    tabId: 'settings:secrets',
    tabType: 'settings',
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
  {
    id: 'ssh-quick',
    label: 'SSH',
    icon: Key,
    group: 'quickActions',
    subGroup: 'security',
    showIn: ['rightSidebar', 'commandPalette'],
    kind: 'action',
    actionId: 'generateSSHKey',
    keywords: 'ssh key generate public private git clone remote',
  },
  {
    id: 'api-keys-quick',
    label: 'API',
    icon: Cable,
    group: 'quickActions',
    subGroup: 'security',
    showIn: ['rightSidebar'],
    kind: 'navigate',
    href: '/settings/api-keys',
    tabId: 'settings:api-keys',
    tabType: 'settings',
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
    id: 'marketplace',
    label: 'Marketplace',
    icon: Sparkles,
    group: 'navigation',
    showIn: [],
    subGroup: 'tools',
    kind: 'navigate',
    href: '/marketplace',
  },
  {
    id: 'projects',
    label: 'Projects',
    icon: FolderKanban,
    group: 'navigation',
    subGroup: 'tools',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/projects',
    keywords: 'project task milestone kanban board plan auto orchestrate',
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
    id: 'channels',
    label: 'Channels',
    icon: MessageSquare,
    group: 'navigation',
    subGroup: 'services',
    showIn: ['commandPalette', 'rightSidebar'],
    kind: 'navigate',
    href: '/channels',
  },
  {
    id: 'tunnel',
    label: 'Tunnel',
    icon: Cable,
    group: 'navigation',
    subGroup: 'services',
    showIn: ['rightSidebar'],
    kind: 'navigate',
    href: '/tunnel',
  },
  {
    id: 'connectors',
    label: 'Connectors',
    icon: Plug,
    group: 'navigation',
    subGroup: 'services',
    showIn: ['commandPalette', 'rightSidebar'],
    kind: 'navigate',
    href: '/connectors',
  },
  ...(DEPLOYMENTS_ENABLED
    ? [{
      id: 'deployments',
      label: 'Deployments',
      icon: Rocket,
      group: 'navigation' as const,
      subGroup: 'services' as const,
      showIn: ['commandPalette', 'rightSidebar'] as MenuSurface[],
      kind: 'navigate' as const,
      href: '/deployments',
    }]
    : []),
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
    icon: Monitor,
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
    id: 'tunnel',
    label: 'Tunnel',
    icon: Cable,
    group: 'navigation',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/tunnel',
    keywords: 'tunnel ngrok expose port localhost remote',
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
    keywords: 'service manager services orchestration process manager sandbox active restart reload',
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
    icon: Monitor,
    group: 'navigation',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/desktop',
    tabId: 'desktop:main',
    tabType: 'desktop',
    keywords: 'desktop selkies novnc full screen xfce sandbox vnc remote',
  },
  {
    id: 'templates',
    label: 'Templates',
    icon: LayoutTemplate,
    group: 'navigation',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/templates',
    keywords: 'templates starter project boilerplate',
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
    href: '/credits-explained',
    keywords: 'credits coins billing usage tokens cost explain',
  },

  // ──────────────────────────────────────────────────────────────────────────
  // SETTINGS PAGES (navigate to route)
  // ──────────────────────────────────────────────────────────────────────────
  {
    id: 'secrets-manager',
    label: 'Secrets Manager',
    icon: KeyRound,
    group: 'settingsPages',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/settings/credentials',
    tabType: 'settings',
    keywords: 'secrets manager credentials env environment variables integrations keys',
  },
  {
    id: 'api-keys',
    label: 'API Keys',
    icon: SettingsIcon,
    group: 'settingsPages',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/settings/api-keys',
    tabType: 'settings',
  },
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
    id: 'pref-notifications',
    label: 'Notifications',
    icon: Bell,
    group: 'preferences',
    showIn: ['commandPalette'],
    kind: 'settings',
    settingsTab: 'notifications',
    keywords: 'notifications alerts push web browser desktop',
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
    keywords: 'billing payment credit card subscription manage',
    requiresBilling: true,
  },
  {
    id: 'account-transactions',
    label: 'Transactions',
    icon: Receipt,
    group: 'account',
    showIn: ['commandPalette'],
    kind: 'settings',
    settingsTab: 'transactions',
    keywords: 'transactions credits history purchases receipts',
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

  // ──────────────────────────────────────────────────────────────────────────
  // ADMIN
  // ──────────────────────────────────────────────────────────────────────────
  {
    id: 'admin-access-requests',
    label: 'Admin: Access Requests',
    icon: UserPlus,
    group: 'admin',
    showIn: ['userMenu', 'commandPalette'],
    kind: 'navigate',
    href: '/admin/access-requests',
    requiresAdmin: true,
    keywords: 'admin access requests users waitlist approve',
  },
  {
    id: 'admin-sandboxes',
    label: 'Admin: Sandboxes',
    icon: Server,
    group: 'admin',
    showIn: ['userMenu', 'commandPalette'],
    kind: 'navigate',
    href: '/admin/sandboxes',
    requiresAdmin: true,
    keywords: 'admin sandboxes all containers instances pool warm',
  },
  {
    id: 'admin-analytics',
    label: 'Admin: Analytics',
    icon: BarChart2,
    group: 'admin',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/admin/analytics',
    requiresAdmin: true,
    keywords: 'admin analytics dashboard metrics statistics',
  },
  {
    id: 'admin-feedback',
    label: 'Admin: Feedback',
    icon: MessageCircle,
    group: 'admin',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/admin/feedback',
    requiresAdmin: true,
    keywords: 'admin feedback user reports',
  },
  {
    id: 'admin-notifications',
    label: 'Admin: Notifications',
    icon: Bell,
    group: 'admin',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/admin/notifications',
    requiresAdmin: true,
    keywords: 'admin notifications push broadcast',
  },
  {
    id: 'admin-utils',
    label: 'Admin: Utils',
    icon: Wrench,
    group: 'admin',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/admin/utils',
    requiresAdmin: true,
    keywords: 'admin utils utilities tools maintenance',
  },
  {
    id: 'admin-sandbox-pool',
    label: 'Admin: Sandbox Pool',
    icon: Database,
    group: 'admin',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/admin/sandboxes',
    requiresAdmin: true,
    keywords: 'admin sandbox pool warm instances',
  },
  {
    id: 'admin-stateless',
    label: 'Admin: Stateless',
    icon: Gauge,
    group: 'admin',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/admin/stateless',
    requiresAdmin: true,
    keywords: 'admin stateless mode configuration',
  },
  {
    id: 'admin-stress-test',
    label: 'Admin: Stress Test',
    icon: TestTube,
    group: 'admin',
    showIn: ['commandPalette'],
    kind: 'navigate',
    href: '/admin/stress-test',
    requiresAdmin: true,
    keywords: 'admin stress test load performance',
  },
];

// ============================================================================
// Selectors — filter the registry for each surface
// ============================================================================

export function getItemsForSurface(surface: MenuSurface): MenuItemDef[] {
  return menuRegistry.filter((item) => item.showIn.includes(surface));
}

export function getItemsByGroup(
  surface: MenuSurface,
  group: MenuGroup,
): MenuItemDef[] {
  return menuRegistry.filter(
    (item) => item.showIn.includes(surface) && item.group === group,
  );
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
export function getNavItemsClustered(
  surface: MenuSurface,
  group: MenuGroup,
): MenuItemDef[][] {
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
  icon: LucideIcon;
}

/** Preference tabs for the settings modal */
export function getPreferenceTabs(): SettingsTab[] {
  const preferenceIds: SettingsTabId[] = ['general', 'appearance', 'sounds', 'notifications', 'shortcuts'];
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

/** Account tabs for the settings modal */
export function getAccountTabs(billingEnabled: boolean): SettingsTab[] {
  const items: SettingsTab[] = [
    { id: 'billing', label: 'Billing', icon: CreditCard },
    { id: 'transactions', label: 'Transactions', icon: Receipt },
  ];
  // Referrals tab disabled for now
  // if (billingEnabled) {
  //   items.push({ id: 'referrals', label: 'Referrals', icon: Users });
  // }
  // Enrich labels/icons from registry where possible
  return items.map((tab) => {
    const item = menuRegistry.find(
      (i) => i.settingsTab === tab.id,
    );
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

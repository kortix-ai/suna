/**
 * Settings tab identifiers + helpers.
 *
 * This is the merged vocabulary for every project-configuration pane Kortix
 * has. The panes are split across TWO surfaces, and `SettingsSurface` is the
 * split:
 *
 *  - `customize` — what this project's agent IS and what it CAN DO. Agents,
 *    Skills, Models, Connectors, Apps, Channels, Schedules, Webhooks, Secrets,
 *    Sandbox templates, Snapshots, Marketplace. Opened by the sidebar's
 *    Customize row, deep-linked at `/projects/[id]/customize/<tab>`.
 *  - `settings` — administration of the account, project and organization.
 *    Profile, Preferences, Members, Billing, Roles, Audit log, API keys, ...
 *    Opened by the sidebar's Settings row (Mod+,), deep-linked at
 *    `/projects/[id]/settings/<tab>`.
 *
 * Both surfaces render through the SAME shell (`settings-panel.tsx`) with the
 * same rail mechanics; only the rail groups and the heading differ. A tab
 * belongs to exactly one surface — `TAB_SURFACE` is that mapping and
 * `settingsTabHref` is the only correct way to build a deep link, so a link
 * can never point a tab at the surface that does not list it.
 *
 * Files and Changes are NOT panes — they are standalone
 * `/projects/[id]/files` routes. Everything else that used to live across the
 * three old settings surfaces (the Customize overlay, the user settings modal,
 * the account settings page) lives here, in some cases under a new id — see
 * `legacySectionRedirect`, which still resolves every legacy id in the wild.
 */

export type SettingsTab =
  | 'profile'
  | 'preferences'
  | 'connected'
  | 'general'
  | 'members'
  | 'secrets'
  | 'channels'
  | 'repositories'
  | 'schedules'
  | 'webhooks'
  | 'models'
  | 'agents'
  | 'skills'
  | 'connectors'
  | 'apps'
  | 'marketplace'
  | 'review'
  | 'voice'
  | 'sandbox'
  | 'snapshots'
  | 'organization'
  | 'billing'
  | 'usage'
  | 'groups'
  | 'roles'
  | 'identity'
  | 'audit'
  | 'api-keys'
  | 'experimental'
  | 'upgrades';

/** The two panels a tab can live in. See this file's header. */
export type SettingsSurface = 'customize' | 'settings';

/**
 * Which panel owns each tab.
 *
 * A `Record` (not a partial) on purpose: adding a member to `SettingsTab`
 * without deciding its surface is a type error, not a tab that silently
 * disappears from both rails. `rail.ts` asserts every entry here appears in
 * exactly one rail group of that surface.
 */
export const TAB_SURFACE: Record<SettingsTab, SettingsSurface> = {
  agents: 'customize',
  skills: 'customize',
  models: 'customize',
  review: 'customize',
  connectors: 'customize',
  apps: 'customize',
  channels: 'customize',
  voice: 'customize',
  schedules: 'customize',
  webhooks: 'customize',
  secrets: 'customize',
  sandbox: 'customize',
  snapshots: 'customize',
  marketplace: 'customize',

  profile: 'settings',
  preferences: 'settings',
  connected: 'settings',
  general: 'settings',
  members: 'settings',
  repositories: 'settings',
  organization: 'settings',
  billing: 'settings',
  usage: 'settings',
  groups: 'settings',
  roles: 'settings',
  identity: 'settings',
  audit: 'settings',
  'api-keys': 'settings',
  experimental: 'settings',
  upgrades: 'settings',
};

export function surfaceForTab(tab: SettingsTab): SettingsSurface {
  return TAB_SURFACE[tab];
}

/** The canonical deep link for a tab — always on the surface that owns it. */
export function settingsTabHref(projectId: string, tab: SettingsTab): string {
  return `/projects/${projectId}/${TAB_SURFACE[tab]}/${tab}`;
}

/**
 * Each surface's default tab. It must be a tab that is actually in that
 * surface's rail with every flag off and every permission denied-by-default,
 * or the panel opens on nothing.
 *
 * Settings → General: it survives every flag and is the tab the panel is most
 * often opened for. Customize → Agents: the first row of the first group, and
 * the reason someone opens Customize at all.
 */
export const DEFAULT_SETTINGS_TAB: SettingsTab = 'general';
export const DEFAULT_CUSTOMIZE_TAB: SettingsTab = 'agents';

export function defaultTabForSurface(surface: SettingsSurface): SettingsTab {
  return surface === 'customize' ? DEFAULT_CUSTOMIZE_TAB : DEFAULT_SETTINGS_TAB;
}

export const SETTINGS_TABS: readonly SettingsTab[] = Object.keys(TAB_SURFACE) as SettingsTab[];

export function parseSettingsTab(raw: string | null | undefined): SettingsTab | null {
  if (!raw) return null;
  return (SETTINGS_TABS as readonly string[]).includes(raw) ? (raw as SettingsTab) : null;
}

/**
 * Sections that are not panes at all — they are their own routes, so a deep
 * link into either panel leaves the panel entirely.
 *
 * Agents, Connectors and Skills used to be listed here: they were standalone
 * `/projects/[id]/{agent,connectors,skills}` pages behind a three-tab bar.
 * They are Customize panes now, so those ids resolve through `RENAMED_TABS`
 * instead and their old routes redirect into the Customize panel.
 */
const GRADUATED: Record<string, (projectId: string) => string> = {
  files: (p) => `/projects/${p}/files`,
  changes: (p) => `/projects/${p}/files?panel=proposed-changes`,
};

/**
 * Sections that stayed a pane but changed id along the way.
 *
 * `settings` -> `general` comes from the old Customize overlay; `tokens` ->
 * `api-keys` and `transactions` -> `usage` come from the old account settings
 * surface (`SettingsTabId` in `lib/menu-registry.ts`); `git` ->
 * `repositories` is a rename within Customize; `upgrade` (singular, the old
 * Customize id) -> `upgrades` (plural, the new tab id) so a bookmarked
 * `/customize/upgrade` still resolves instead of silently 404ing; every
 * `llm-*` sub-section collapses into the single `models` tab.
 *
 * `agent` (singular) was the route segment for the Agents page and `agents`
 * (plural) was the overlay section id; both spellings resolve to the `agents`
 * pane, because both are in the wild. `computers` resolves to Connectors —
 * device pairing and per-capability grants became a connector on `main`
 * (#6313, `ComputerTunnelManager` in `capabilities/connectors/`).
 *
 * `commands` is deliberately absent. It used to map to the `instructions`
 * tab, which was removed along with its only content (`CommandsView`) — a
 * settings surface with no project-level instructions field behind it. There
 * is no successor pane to fold it into, so `/customize/commands` resolves to
 * `null` here and the route falls back to the bare panel rather than
 * deep-linking to a tab that no longer renders anything.
 */
const RENAMED_TABS: Record<string, SettingsTab> = {
  settings: 'general',
  git: 'repositories',
  tokens: 'api-keys',
  transactions: 'usage',
  upgrade: 'upgrades',
  agent: 'agents',
  computers: 'connectors',
  'llm-management': 'models',
  'llm-overview': 'models',
  'llm-providers': 'models',
  'llm-logs': 'models',
  'llm-budgets': 'models',
  'llm-keys': 'models',
  'llm-api': 'models',
};

/**
 * Resolve a legacy section/tab id to where it lives now. A section that is its
 * own route leaves the panel entirely; every other known id resolves to
 * `settingsTabHref` — which puts it on the surface that owns it today, so a
 * bookmarked `/settings/secrets` lands in Customize now rather than opening a
 * Settings rail that no longer lists it. Anything unrecognized returns `null`.
 */
export function legacySectionRedirect(
  projectId: string,
  rawSection: string | null | undefined,
): string | null {
  if (!rawSection) return null;

  const graduated = GRADUATED[rawSection];
  if (graduated) return graduated(projectId);

  const renamed = RENAMED_TABS[rawSection];
  if (renamed) return settingsTabHref(projectId, renamed);

  const live = parseSettingsTab(rawSection);
  if (live) return settingsTabHref(projectId, live);

  return null;
}

/** Whether an href matching `/(customize|settings)(/<segment>)?` opens a panel. */
export type SettingsOverlayMatch =
  | { opensOverlay: true; surface: SettingsSurface; tab: SettingsTab | undefined }
  | { opensOverlay: false };

/**
 * Decide whether a menu-registry href should open a panel, which one, and on
 * which tab — the command palette's only use of this is a pure lookup, so it
 * is extracted here to be unit-tested without mounting the palette.
 *
 * A bare `/customize` or `/settings` (no segment) opens that panel on its own
 * default tab. A named segment only opens a panel when it resolves through
 * `parseSettingsTab` to a REAL tab, and then it opens on the surface that OWNS
 * that tab, not the one in the href — a stale `/settings/secrets` opens
 * Customize. Files and Changes are not tabs, so a `/settings/files` href must
 * NOT open a panel: `openSettings(undefined)` would silently reopen it on
 * whatever tab was last viewed instead of navigating anywhere. The caller is
 * expected to fall through to a normal `router.push(href)` when this returns
 * `{ opensOverlay: false }`.
 */
export function resolveSettingsOverlayHref(href: string): SettingsOverlayMatch {
  const match = href.match(/\/(customize|settings)(?:\/([^/?#]+))?/);
  if (!match) return { opensOverlay: false };
  const surface = match[1] as SettingsSurface;
  if (!match[2]) return { opensOverlay: true, surface, tab: undefined };
  const tab = parseSettingsTab(match[2]);
  return tab ? { opensOverlay: true, surface: TAB_SURFACE[tab], tab } : { opensOverlay: false };
}

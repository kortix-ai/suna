/**
 * Settings tab identifiers + helpers.
 *
 * This is the merged vocabulary for Kortix's three former settings surfaces —
 * the project Customize overlay, the user settings modal, and the account
 * settings page — now collapsed into one project-scoped settings overlay at
 * `/projects/[id]/settings(/<tab>)?`. It reads its active tab from the path
 * segment or, for legacy links, the old `?section=` / `?customize=` query
 * params. This module keeps the tab enum, the default, and a parser in one
 * spot so the overlay, the sidebar, and any deep-link helpers all agree on
 * the canonical list.
 *
 * Files, Changes, Agent(s), Connectors, and Skills are NOT settings tabs —
 * they are standalone `/projects/[id]/<section>` pages (any member can
 * browse Files; Agent/Connectors/Skills gate on their own read leaf — see
 * capabilities/capability-tab-routes.ts). Everything else that used to live
 * across the three old surfaces now lives here, in some cases under a new
 * id — see `legacySectionRedirect`. Deep-link routes still accept every
 * legacy section/tab name and redirect them where applicable.
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
  | 'computers'
  | 'models'
  | 'instructions'
  | 'marketplace'
  | 'review'
  | 'voice'
  | 'sandbox'
  | 'snapshots'
  | 'billing'
  | 'usage'
  | 'groups'
  | 'roles'
  | 'identity'
  | 'audit'
  | 'api-keys'
  | 'experimental'
  | 'upgrades';

/**
 * The default must be a tab that is actually in the rail with every flag
 * off, or the overlay opens on nothing. Every gated tab (Members, Groups,
 * Roles, Audit, ...) can disappear behind a permission or a flag; General
 * survives every flag, and it is the tab the panel is most often opened for.
 */
export const DEFAULT_SETTINGS_TAB: SettingsTab = 'general';

export const SETTINGS_TABS: readonly SettingsTab[] = [
  'profile',
  'preferences',
  'connected',
  'general',
  'members',
  'secrets',
  'channels',
  'repositories',
  'schedules',
  'webhooks',
  'computers',
  'models',
  'instructions',
  'marketplace',
  'review',
  'voice',
  'sandbox',
  'snapshots',
  'billing',
  'usage',
  'groups',
  'roles',
  'identity',
  'audit',
  'api-keys',
  'experimental',
  'upgrades',
];

export function parseSettingsTab(raw: string | null | undefined): SettingsTab | null {
  if (!raw) return null;
  return (SETTINGS_TABS as readonly string[]).includes(raw) ? (raw as SettingsTab) : null;
}

/**
 * Sections that graduated out of the settings overlay into their own routes.
 * Deep links and bookmarks into `/customize/<section>` or `/settings/<section>`
 * land on the new page instead of opening the overlay.
 */
const GRADUATED: Record<string, (projectId: string) => string> = {
  files: (p) => `/projects/${p}/files`,
  changes: (p) => `/projects/${p}/files?panel=proposed-changes`,
  // The overlay section was `agents`; the route segment is `agent`. Both
  // spellings redirect, because every bookmark and stale href in the wild
  // points at the plural one.
  agent: (p) => `/projects/${p}/agent`,
  agents: (p) => `/projects/${p}/agent`,
  connectors: (p) => `/projects/${p}/connectors`,
  skills: (p) => `/projects/${p}/skills`,
};

/**
 * Sections that stayed in the overlay but changed id across the merge.
 * `commands` -> `instructions` and `settings` -> `general` come from the old
 * Customize overlay; `tokens` -> `api-keys` and `transactions` -> `usage`
 * come from the old account settings surface (`SettingsTabId` in
 * `lib/menu-registry.ts`); `git` -> `repositories` is a rename within
 * Customize; `upgrade` (singular, the old Customize id) -> `upgrades`
 * (plural, the new tab id) so a bookmarked `/customize/upgrade` still
 * resolves instead of silently 404ing; every `llm-*` sub-section collapses
 * into the single `models` tab.
 */
const RENAMED_TABS: Record<string, SettingsTab> = {
  commands: 'instructions',
  settings: 'general',
  git: 'repositories',
  tokens: 'api-keys',
  transactions: 'usage',
  upgrade: 'upgrades',
  'llm-management': 'models',
  'llm-overview': 'models',
  'llm-providers': 'models',
  'llm-logs': 'models',
  'llm-budgets': 'models',
  'llm-keys': 'models',
  'llm-api': 'models',
};

/**
 * Resolve a legacy section/tab id (from any of the three old settings
 * surfaces) to where it lives now. Graduated pages leave the overlay
 * entirely; renamed tabs resolve to their new id inside the overlay; a tab
 * whose id never changed resolves to its own `/settings/<id>`; anything
 * unrecognized returns `null`.
 */
export function legacySectionRedirect(
  projectId: string,
  rawSection: string | null | undefined,
): string | null {
  if (!rawSection) return null;

  const graduated = GRADUATED[rawSection];
  if (graduated) return graduated(projectId);

  const renamed = RENAMED_TABS[rawSection];
  if (renamed) return `/projects/${projectId}/settings/${renamed}`;

  if (parseSettingsTab(rawSection)) return `/projects/${projectId}/settings/${rawSection}`;

  return null;
}

/** Whether an href matching `/settings(/<segment>)?` should open the overlay. */
export type SettingsOverlayMatch =
  | { opensOverlay: true; tab: SettingsTab | undefined }
  | { opensOverlay: false };

/**
 * Decide whether a menu-registry href should open the settings overlay, and
 * on which tab — the command palette's only use of this is a pure lookup,
 * so it is extracted here to be unit-tested without mounting the palette.
 *
 * A bare `/settings` (no segment) opens the overlay on its default tab.
 * A named segment only opens the overlay when it resolves through
 * `parseSettingsTab` to a REAL tab. Files, Agent(s), Connectors, and Skills
 * graduated out of `SettingsTab`, so a stale `/settings/skills` href (or any
 * other unresolvable segment) must NOT open the overlay —
 * `openSettings(undefined)` would otherwise silently reopen it on whatever
 * tab the user last viewed instead of navigating anywhere. The caller is
 * expected to fall through to a normal `router.push(href)` when this returns
 * `{ opensOverlay: false }`.
 */
export function resolveSettingsOverlayHref(href: string): SettingsOverlayMatch {
  const match = href.match(/\/settings(?:\/([^/?#]+))?/);
  if (!match) return { opensOverlay: false };
  if (!match[1]) return { opensOverlay: true, tab: undefined };
  const tab = parseSettingsTab(match[1]);
  return tab ? { opensOverlay: true, tab } : { opensOverlay: false };
}

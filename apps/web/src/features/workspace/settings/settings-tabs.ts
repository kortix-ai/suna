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
 * The account-scoped half of that merge has since been undone, on purpose.
 * Organization (General, Billing, Usage, Groups, Roles, Identity, Audit log)
 * and API keys configured the ACCOUNT, not the project, so a project overlay
 * was the wrong home for them: the same controls already had a full page at
 * `/accounts/[id]`, and two doors onto one set of settings is one door too
 * many. Those ids live in `ACCOUNT_GRADUATED` now and redirect to that page.
 *
 * Files, Changes, Agent(s), Connectors, and Skills are NOT settings tabs —
 * they are standalone `/projects/[id]/<section>` pages (any member can
 * browse Files; Agent/Connectors/Skills gate on their own read leaf — see
 * capabilities/capability-tab-routes.ts). Everything else that used to live
 * across the three old surfaces now lives here, in some cases under a new
 * id — see `legacySectionRedirect`. Deep-link routes still accept every
 * legacy section/tab name and redirect them where applicable.
 */

import { channelsHref } from '@/features/workspace/capabilities/shared/capability-tab-routes';

export type SettingsTab =
  | 'profile'
  | 'preferences'
  | 'connected';
// Organization (General, Billing, Usage, Groups, Roles, Identity, Audit log)
// and API keys are gone: every one of them configured the ACCOUNT, not the
// project, and the account already owns a full page for them at
// `/accounts/[id]`. They resolve through `ACCOUNT_GRADUATED` below.
//
// The project's own configuration is gone too — General, Members, Secrets,
// Channels, Repositories, Models, Sandbox templates, Snapshots, Marketplace,
// Review, Voice, Feature flags (was `experimental`) and Upgrades. All thirteen
// are sections of the Customize bar's Settings tab now, at
// `/projects/[id]/config?section=<key>`, and resolve through `GRADUATED`.
// What is left in this overlay is exactly what is scoped to the PERSON using
// it: Profile, Preferences, Connected accounts.

/**
 * The default must be a tab that survives every gate, or the overlay opens on
 * nothing. It was `general` until project configuration moved to
 * `/projects/[id]/config`; `profile` is the first surviving tab and the one
 * every signed-in user can always open — no permission, no flag, no project.
 */
export const DEFAULT_SETTINGS_TAB: SettingsTab = 'profile';

export const SETTINGS_TABS: readonly SettingsTab[] = ['profile', 'preferences', 'connected'];

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
  // Computers graduated out of settings on `main` (#6313): device pairing and
  // per-capability grants are a connector now (`ComputerTunnelManager` in
  // `capabilities/connectors/`), so a bookmarked `/customize/computers` or
  // `/settings/computers` lands on the Connectors page instead of a tab that
  // no longer exists.
  computers: (p) => `/projects/${p}/connectors`,
  skills: (p) => `/projects/${p}/skills`,
  // Schedules and Webhooks graduated out of the overlay, merged into one
  // Triggers capability page (a trigger is one resource with two ways to
  // start it). Every `/settings/schedules`, `/settings/webhooks`,
  // `/customize/schedules` and `/customize/webhooks` bookmark in the wild
  // lands on the merged page instead of a tab that no longer exists.
  schedules: (p) => `/projects/${p}/triggers`,
  webhooks: (p) => `/projects/${p}/triggers`,

  // ── Project configuration → the Customize bar's Settings tab ────────────
  // Most of the old overlay's Workspace/Agent rail became `?section=` values
  // on one page (`capabilities/project-settings/project-settings-sections.ts`).
  // The section key equals the old tab id in every case but one:
  // `experimental` is `feature-flags`, the name the pane already carries
  // everywhere else. Four sections graduated a SECOND time, off that page
  // and onto their own top-level Customize tab — Secrets, Channels, Models,
  // Members — and Marketplace was removed from the product outright.
  //
  // The URL segment is `config`, not `settings` — `/projects/<id>/settings`
  // is this overlay's own deep-link route and cannot be two routes at once.
  general: (p) => `/projects/${p}/config`,
  // `settings` is the old Customize overlay's id for the same pane.
  settings: (p) => `/projects/${p}/config`,
  // Repositories is gone as its own pane — its content merged into General
  // under a "Git repo" section. `general`, bare, is the honest destination:
  // General is the config page's default section.
  repositories: (p) => `/projects/${p}/config`,
  // `git` was the pre-rename id for Repositories.
  git: (p) => `/projects/${p}/config`,
  // Secrets, Channels, Models, and Members graduated a SECOND time — off the
  // Settings sub-nav entirely and onto their own top-level Customize tab.
  // `models` and every `llm-*` sub-section (the old Models pane's own
  // sub-tabs) all land on the one Models tab; which sub-tab a person sees
  // inside it is that page's own state, not a route.
  secrets: (p) => `/projects/${p}/secrets`,
  // Channels graduated a second time and then came back down: it is a scope of
  // the Connectors page now, not a tab of its own. `channelsHref` is that one
  // URL, shared with the retired `/projects/<id>/channels` route so the two
  // cannot disagree about the param.
  channels: (p) => channelsHref(p),
  models: (p) => `/projects/${p}/models`,
  members: (p) => `/projects/${p}/members`,
  'llm-management': (p) => `/projects/${p}/models`,
  'llm-overview': (p) => `/projects/${p}/models`,
  'llm-providers': (p) => `/projects/${p}/models`,
  'llm-logs': (p) => `/projects/${p}/models`,
  'llm-budgets': (p) => `/projects/${p}/models`,
  'llm-keys': (p) => `/projects/${p}/models`,
  'llm-api': (p) => `/projects/${p}/models`,
  sandbox: (p) => `/projects/${p}/config?section=sandbox`,
  // Snapshots merged INTO the sandbox section — a snapshot is the build
  // history of a sandbox template, not a separate pane any more.
  snapshots: (p) => `/projects/${p}/config?section=sandbox`,
  // Marketplace was removed from the product outright, not relocated. The
  // closest honest destination for a stale bookmark is the Customize index —
  // it lists every surface that replaced it, rather than a 404 or a pane that
  // no longer exists.
  marketplace: (p) => `/projects/${p}/customize`,
  review: (p) => `/projects/${p}/config?section=review`,
  voice: (p) => `/projects/${p}/config?section=voice`,
  // Renamed on the move: the row is called "Feature flags" now.
  experimental: (p) => `/projects/${p}/config?section=feature-flags`,
  'feature-flags': (p) => `/projects/${p}/config?section=feature-flags`,
  upgrades: (p) => `/projects/${p}/config?section=upgrades`,
  // `upgrade`, singular, is the old Customize id for the same pane.
  upgrade: (p) => `/projects/${p}/config?section=upgrades`,
};

/**
 * Sections that graduated out of the settings overlay onto the ACCOUNT
 * settings page, `/accounts/[id]` — keyed by legacy section id, valued by the
 * `?tab=` segment that page reads (`VALID_TABS` in
 * `app/(app)/accounts/[id]/page.tsx`).
 *
 * **Why these are a separate map from `GRADUATED`.** Every entry above is
 * project-scoped, so a project id is all it needs. Every entry here is
 * ACCOUNT-scoped: the destination is `/accounts/<accountId>`, and an account
 * id cannot be derived from a project id synchronously — it is a field on the
 * project detail (`project.account_id`), which is a network read. Folding
 * these into `GRADUATED` would either force that map async or make it lie
 * about which id it takes. So the maps stay split and the CALLER resolves the
 * account id, then passes it as `legacySectionRedirect`'s third argument. See
 * `use-account-section-redirect.ts` for the one hook every call site uses.
 *
 * Three ids are not 1:1 renames — the account page's own vocabulary differs:
 * the overlay's `organization` (org name + sign-in rules) is that page's
 * `settings` tab, its `usage` is `transactions`, and its `api-keys` is
 * `tokens`. The legacy `transactions` / `tokens` ids are listed too: they used
 * to live in `RENAMED_TABS` (folded INTO the overlay), and now that the
 * overlay has no such tab they must resolve back to the account page instead
 * of falling through to the bare `/settings` overlay.
 */
export const ACCOUNT_GRADUATED: Record<string, string> = {
  organization: 'settings',
  billing: 'billing',
  usage: 'transactions',
  transactions: 'transactions',
  groups: 'groups',
  roles: 'roles',
  identity: 'identity',
  audit: 'audit',
  'api-keys': 'tokens',
  tokens: 'tokens',
};

/**
 * Whether a legacy section id needs an ACCOUNT id to resolve.
 *
 * Call sites use this to decide whether to pay for the project-detail read
 * that yields `project.account_id` — a section that is not account-scoped
 * resolves synchronously through `legacySectionRedirect` with no extra work.
 */
export function isAccountGraduatedSection(rawSection: string | null | undefined): boolean {
  return !!rawSection && Object.hasOwn(ACCOUNT_GRADUATED, rawSection);
}

/**
 * Resolve a legacy section/tab id (from any of the three old settings
 * surfaces) to where it lives now. Graduated ids leave the overlay entirely —
 * for their own page, or for a `?section=` on the Customize bar's Settings
 * tab; a tab that is still in the overlay resolves to its own
 * `/settings/<id>`; anything unrecognized returns `null`.
 *
 * There is no rename map left. Every id that used to be renamed INTO the
 * overlay (`settings`, `git`, `upgrade`, the seven `llm-*` ids) now names a
 * surface outside it, so all of them are entries in `GRADUATED` above.
 *
 * **`accountId` is optional and is checked FIRST.** It is the caller's
 * resolved account id, needed only by `ACCOUNT_GRADUATED` ids — everything
 * else ignores it. Passing `undefined` for an account-scoped id returns
 * `null` rather than a wrong URL, which sends the caller to its own fallback;
 * `isAccountGraduatedSection` lets a caller detect that case up front and
 * wait for the id instead. `use-account-section-redirect.ts` does exactly
 * that and is what every call site should use.
 */
export function legacySectionRedirect(
  projectId: string,
  rawSection: string | null | undefined,
  accountId?: string,
): string | null {
  if (!rawSection) return null;

  // `isAccountGraduatedSection`, not a bare `ACCOUNT_GRADUATED[rawSection]`:
  // a plain object literal inherits `Object.prototype`, so the bare lookup
  // answers truthy for `constructor`, `toString`, `valueOf` and friends. A
  // stale link to `/settings/constructor` would have redirected to
  // `/accounts/<id>?tab=function Object() { [native code] }`. The helper uses
  // `Object.hasOwn`.
  if (accountId && isAccountGraduatedSection(rawSection)) {
    return `/accounts/${accountId}?tab=${ACCOUNT_GRADUATED[rawSection]}`;
  }

  // Guarded for the same reason as the account map above — a plain object
  // literal inherits `Object.prototype`, so `GRADUATED['constructor']` used to
  // answer with the `Object` constructor and `/settings/constructor` redirected
  // to `Object('p1')`, i.e. the string "p1", as a URL.
  if (Object.hasOwn(GRADUATED, rawSection)) return GRADUATED[rawSection](projectId);

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

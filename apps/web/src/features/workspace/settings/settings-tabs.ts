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
  // Security, Appearance and Sessions were sections of Profile and
  // Preferences until 2026-09-02, when Jay asked for "the proper segments":
  // two-factor and devices on their own tab; theme/wallpaper/density on their
  // own; sounds and notifications on their own. Each is person-scoped, like
  // the pane it came from.
  | 'security'
  | 'appearance'
  | 'sessions'
  | 'preferences'
  | 'connected'
  // API keys came BACK, and only half of what left returned. The old
  // `api-keys` tab listed three kinds of credential at once — a person's own
  // keys, service-account bearers, and the connector tokens the runtime mints
  // per sandbox — so it configured the account and it graduated to
  // `/accounts/[id]` with the rest of the account surface. What is here now is
  // the half that was never account configuration: the keys YOU minted, which
  // act as you and die with your membership. The automation half stayed on the
  // account page under the same `?tab=tokens` segment, which is why the word
  // names two surfaces — this pane for a person's keys, that pane for an
  // automation's. Marko, 2026-08-18:
  // "the personal tokens should be in the personal settings and visible there.
  // the automation tokens should be in the actual account settings."
  | 'tokens'
  // The account's plan — subscription, credits, billing portal. The SAME
  // `BillingTab` `/accounts/[id]?tab=billing` renders, mounted a second time
  // here (Jay, 2026-09-02: "a section for the plan that shows the
  // subscription and the current plan"). The id is `plan`, not `billing`:
  // `billing` is spent on an `ACCOUNT_GRADUATED` redirect to the account page
  // and a live tab under it would shadow every bookmark pointing there.
  | 'plan'
  // The first PROJECT-scoped tab in an otherwise person-scoped overlay, and a
  // deliberate partial reversal of the graduation described below (Jay,
  // 2026-09-01). Everything else that configures a project genuinely belongs
  // on the Customize bar, but a workspace's NAME and ICON are not
  // configuration a person goes looking for under "Customize" — they are the
  // workspace's identity, and the only way to reach them had become
  // sidebar Customize -> index grid -> Settings -> General, four surfaces deep
  // with no label on the way naming what it does.
  //
  // The id is `workspace`, not `general`: `general` is already spent on a
  // GRADUATED redirect to `/projects/<id>/config` (see the map below), and a
  // live tab sharing that key would shadow every bookmark pointing at it. The
  // rail row is still LABELLED "General" under a "Workspace" group, which is
  // what it was called before it graduated — see `rail.ts`.
  //
  // It renders `tabs/general-tab.tsx`, the same component
  // `/projects/<id>/config?section=general` renders. ONE component, two
  // mounts: nothing is forked, and the config page keeps working unchanged.
  | 'workspace'
  // Two more project-scoped rows, back on 2026-09-02 (Jay: "find some more
  // settings that you can show in the workspace settings"). Both mount the
  // SAME component the config page mounts — `SandboxTab` + `SnapshotsTab`,
  // `ExperimentalTab` — and gate on the same IAM read leaf
  // (`isCustomizeSectionVisible`), so a person sees exactly the rows here that
  // they see on `/projects/<id>/config`. The ids equal the config page's
  // section keys on purpose: `legacySectionRedirect` checks `GRADUATED`
  // BEFORE live tabs, so a stale `/customize/sandbox` bookmark still lands on
  // the config page, while `/settings/sandbox` opens this overlay.
  | 'sandbox'
  | 'feature-flags'
  // Upgrades MOVED here outright on 2026-09-02 (Jay: "move this upgrade
  // section over the settings panel") — it is no longer a section of
  // `/projects/<id>/config`. `UpgradesView` has one mount now, this one.
  | 'upgrades';
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

export const SETTINGS_TABS: readonly SettingsTab[] = [
  'profile',
  'security',
  'appearance',
  'sessions',
  'preferences',
  'connected',
  'tokens',
  'plan',
  // Project-scoped, so NOT in `ACCOUNT_SCOPED_SETTINGS_TABS`
  // (`settings-panel.tsx`): the overlay hides the whole Workspace group when it
  // opens without a project — on `/settings`, or anywhere under `/accounts/**`.
  'workspace',
  'sandbox',
  'feature-flags',
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

  // ── Project configuration → the Settings overlay's Workspace group ──────
  // `/projects/<id>/config` (the Customize bar's Settings tab) was retired on
  // 2026-09-02. Every id that named one of its sections is either a LIVE
  // overlay tab now (`workspace`, `sandbox`, `feature-flags`, `upgrades` —
  // resolved by `parseSettingsTab`) or an old spelling of one (`RENAMED`
  // below). Review, the one section that was an inbox rather than
  // configuration, is a capability tab of its own.
  review: (p) => `/projects/${p}/review`,
  // Secrets, Channels, and Models graduated a SECOND time — off the Settings
  // sub-nav entirely and onto their own top-level Customize tab. `models` and
  // every `llm-*` sub-section (the old Models pane's own sub-tabs) all land
  // on the one Models tab; which sub-tab a person sees inside it is that
  // page's own state, not a route.
  //
  // Members is NOT here. It graduated a second time the same way, to its own
  // top-level tab — then graduated a THIRD time, off the project entirely:
  // membership configures the ACCOUNT, not the project, the same reasoning
  // that moved Organization/Billing/Groups/Roles/Identity/Audit/API keys to
  // `ACCOUNT_GRADUATED` below. `members` lives there now, not here.
  secrets: (p) => `/projects/${p}/secrets`,
  // Channels graduated a second time and then came back down: it is a scope of
  // the Connectors page now, not a tab of its own. `channelsHref` is that one
  // URL, shared with the retired `/projects/<id>/channels` route so the two
  // cannot disagree about the param.
  channels: (p) => channelsHref(p),
  models: (p) => `/projects/${p}/models`,
  'llm-management': (p) => `/projects/${p}/models`,
  'llm-overview': (p) => `/projects/${p}/models`,
  'llm-providers': (p) => `/projects/${p}/models`,
  'llm-logs': (p) => `/projects/${p}/models`,
  'llm-budgets': (p) => `/projects/${p}/models`,
  'llm-keys': (p) => `/projects/${p}/models`,
  'llm-api': (p) => `/projects/${p}/models`,
  // Marketplace was removed from the product outright, not relocated. The
  // closest honest destination for a stale bookmark is the Customize index —
  // it lists every surface that replaced it, rather than a 404 or a pane that
  // no longer exists.
  marketplace: (p) => `/projects/${p}/customize`,
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
 * Two ids are not 1:1 renames — the account page's own vocabulary differs:
 * the overlay's `organization` (org name + sign-in rules) is that page's
 * `settings` tab, and its `usage` is `transactions`. The legacy
 * `transactions` id is listed too: it used to live in `RENAMED_TABS` (folded
 * INTO the overlay), and now that the overlay has no such tab it must resolve
 * back to the account page instead of falling through to the bare `/settings`
 * overlay.
 *
 * `members` is a third non-1:1 entry, and the only one that is not
 * project-agnostic: it targets the account page's `access-projects` tab
 * *scoped back down to the project it was a bookmark for* — see the
 * `rawSection === 'members'` special case in `legacySectionRedirect` below,
 * which appends `&project=<projectId>` that no other entry in this map
 * needs.
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
  // `api-keys` and `tokens` are NOT here any more. Both used to send a stale
  // link to `/accounts/<id>?tab=tokens`, which was right while every
  // credential lived on that one page. Since 2026-08-18 a person's own API
  // keys are back in this overlay as the `tokens` tab and only the automation
  // half stayed on the account page, so both ids resolve to the overlay
  // instead: `tokens` through `parseSettingsTab` (it names a live tab now) and
  // `api-keys` through `RENAMED` below. That is the better default for a stale
  // link — someone who bookmarked "API keys" wanted a key they could use, and
  // the pane they land on carries a one-line pointer to the account page for
  // the other kind.
  members: 'access-projects',
};

/**
 * Legacy ids that came BACK into the overlay under a new name.
 *
 * One entry, and it is a rename rather than a graduation: `api-keys` was this
 * overlay's tab for a person's own API keys before every credential surface
 * moved to `/accounts/[id]`. The personal half has returned as `tokens`, so a
 * stale `/settings/api-keys` or `/customize/api-keys` link lands on the pane
 * that holds what it was a link to, not on the account page's automation tab.
 *
 * Checked BEFORE `ACCOUNT_GRADUATED` so the answer does not depend on whether
 * the caller happened to have resolved an account id yet.
 */
const RENAMED: Record<string, SettingsTab> = {
  'api-keys': 'tokens',
  // `upgrade`, singular, is the old Customize id for the Upgrades pane.
  upgrade: 'upgrades',
  // The retired config page's own vocabulary, and the older ids that fed it.
  // General is the `workspace` tab (`general` itself is a spent id — see
  // `SettingsTab`); Repositories and its pre-rename `git` merged INTO General
  // as a "Git repo" section; Snapshots merged into Sandbox templates;
  // `experimental` was renamed Feature flags on the way.
  general: 'workspace',
  settings: 'workspace',
  repositories: 'workspace',
  git: 'workspace',
  snapshots: 'sandbox',
  experimental: 'feature-flags',
};

/**
 * The overlay tab a raw id names — a live tab, or an old spelling of one
 * (`RENAMED`). `null` for anything else. Shared by `legacySectionRedirect`
 * and the standalone capability pages' `navigate()` adapter, so a pane that
 * still says `navigate('git')` opens the same tab a `/settings/git` link does.
 */
export function resolveOverlayTab(raw: string | null | undefined): SettingsTab | null {
  if (!raw) return null;
  if (Object.hasOwn(RENAMED, raw)) return RENAMED[raw];
  return parseSettingsTab(raw);
}

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

  // A renamed tab is still a tab in THIS overlay, so it resolves the same way
  // a live tab id does — and before the account map, so the answer never
  // depends on whether the caller has an account id in hand yet. `Object.hasOwn`
  // for the same prototype-pollution reason as the two maps below.
  if (Object.hasOwn(RENAMED, rawSection)) {
    return `/projects/${projectId}/settings/${RENAMED[rawSection]}`;
  }

  // `isAccountGraduatedSection`, not a bare `ACCOUNT_GRADUATED[rawSection]`:
  // a plain object literal inherits `Object.prototype`, so the bare lookup
  // answers truthy for `constructor`, `toString`, `valueOf` and friends. A
  // stale link to `/settings/constructor` would have redirected to
  // `/accounts/<id>?tab=function Object() { [native code] }`. The helper uses
  // `Object.hasOwn`.
  if (accountId && isAccountGraduatedSection(rawSection)) {
    const base = `/accounts/${accountId}?tab=${ACCOUNT_GRADUATED[rawSection]}`;
    // `members` is scoped, every other account-graduated id is not: a stale
    // `/projects/<id>/members` bookmark should open the account's Access ›
    // Projects tab pre-filtered to the project it was a bookmark for, not
    // every project the account can see. No other legacy id carries a
    // project-specific destination on the account page, so this stays a
    // narrow special case rather than a second parameter every entry pays for.
    if (rawSection === 'members') return `${base}&project=${projectId}`;
    return base;
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
  { opensOverlay: true; tab: SettingsTab | undefined } | { opensOverlay: false };

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

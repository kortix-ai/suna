import { customizePath, uiRoutes } from '../../lib/routes';

/**
 * The capability pages that graduated out of the Customize overlay. Commands
 * was removed (its standalone page deleted) and lives only in the Customize
 * overlay again — `/customize/commands` via the `proj-commands` palette entry.
 * Order is the tab order; it is also the order the sidebar lists them in.
 *
 * Triggers graduated out of the Settings overlay, where it was two rail tabs
 * (Schedules, Webhooks) rendering one component
 * (`packages/ui/src/customize/triggers/schedule-view.tsx`) filtered by trigger type. It is
 * ONE tab here, not two: both are the same backend resource — a project
 * trigger — that starts an agent either on a schedule or on an incoming
 * request, and a person deciding "how should this start?" should not have to
 * pick a tab before they even know the answer. The type picker lives inside
 * the create flow instead (`schedule/schedule-create-modal.tsx`).
 *
 * Channels went the OTHER way: it was a tab here and is now a scope of the
 * Connectors page (`channelsHref` below). Unlike Schedules/Webhooks the two are
 * NOT one backend resource — `/projects/{id}/channels/*` is inbound reach
 * (Slack, Teams, email installations and their per-channel bindings),
 * `/projects/{id}/connectors/*` is outbound tool access — and nothing merged
 * them. What merged is the navigation: both answer "wire this project to
 * something outside it", and splitting that question across two top-level tabs
 * made the answer depend on knowing which direction the bytes travel.
 *
 * No `icon` field, on purpose. This module is pure data and is imported by
 * SERVER components (`/projects/[id]/channels/page.tsx` needs `channelsHref`);
 * a `@phosphor-icons/react` import here calls `createContext` at module load
 * and fails `next build` ("Failed to collect page data" — Deploy Dev
 * 2026-08-19). The tab bar is text-only anyway (Marko, 2026-08-19: eight mixed
 * 16px glyphs in one row read as clutter); the sidebar Customize row and the
 * index cards keep their own icons in their own client files.
 */
export interface CapabilityTab {
  key:
    | 'agent'
    | 'connectors'
    | 'skills'
    | 'triggers'
    | 'reminders'
    | 'models'
    | 'secrets'
    | 'files'
    | 'review'
    | 'config';
  label: string;
}

/**
 * This array is the tab order, the sidebar order, and — via the first entry
 * the caller may read — the landing tab. `TAB_PREFERENCE` in
 * `project-sidebar/project-settings-nav.tsx` mirrors it and is asserted
 * against it, so reordering here moves the landing tab too.
 *
 * ## Agents lead, everything else is their library
 *
 * Customize is agent-centric (Marko, 2026-09-01). An agent is the only
 * object a project manager grants a person or a group access to — the object
 * policy for `agent` is `closed`, every other resource is `open`
 * (`apps/api/src/iam/authorize.ts`) — so it is the primitive every other
 * decision hangs off: which model it thinks with, which skills it loads,
 * which connectors and secrets it may reach, when a trigger starts it. The
 * bar is ordered the way that decision is made: Agents leads, alone, and the
 * resources an agent draws on — Skills first among them — follow behind a
 * seam. `PRIMARY_TABS` below names the leading group so the bar can draw it.
 *
 * Every tab lives under `/projects/<id>/customize/<segment>` (Marko,
 * 2026-09-03); `CAPABILITY_SEGMENT` maps a key to its segment. The Agents key
 * stays singular for stability, its segment is `agents`, and one agent lives
 * one level deeper, at `agentHref` (`/projects/<id>/customize/agents/<name>`).
 *
 * There is no Settings tab. `/projects/<id>/config` — the bar's trailing
 * "Settings" tab, a sub-nav over General / Sandbox templates / Review /
 * Feature flags / Upgrades — was retired on 2026-09-02 (Jay). Its
 * configuration sections live in the Settings overlay's Workspace group
 * (`settings/rail.ts`, opened with Cmd+, or from the workspace switcher).
 * `settings-tabs.ts` redirects every retired `/config?section=` link.
 *
 * Review is a tab again (Marko, 2026-10-17). It was one from 2026-09-02 to
 * 2026-10-02, then its own sidebar row and page. That row showed an empty
 * inbox to members who can act on nothing in it. As a tab it follows the
 * Customize rule: only a caller holding `project.review.act` sees it.
 *
 * Reminders is a tab (Marko, 2026-10-19). It was a sidebar row, shown to every
 * member while a reminder could still fire. It follows the Triggers rule: a
 * reminder is a session-scoped trigger, so the tab shows only to a caller who
 * can configure triggers.
 *
 * Two tabs are flag-gated: Repo needs the `drives` flag, Reminders the
 * `reminders` flag (`capabilityAccess()`). Every other tab is always painted.
 */
export const CAPABILITY_TABS: readonly CapabilityTab[] = [
  { key: 'agent', label: 'Agents' },
  { key: 'skills', label: 'Skills' },
  { key: 'connectors', label: 'Connectors' },
  { key: 'triggers', label: 'Triggers' },
  { key: 'reminders', label: 'Loops' },
  { key: 'models', label: 'Models' },
  { key: 'secrets', label: 'Secrets' },
  { key: 'files', label: 'Repo' },
  { key: 'review', label: 'Review' },
  { key: 'config', label: 'Settings' },
];

/**
 * The tab the bar is built around. Agents alone (Marko, 2026-09-03): the
 * agent is the object a person is granted, and everything to the right of
 * the seam — Skills included — is what an agent draws on. The bar draws a
 * hairline seam after it, and it is the landing tab.
 */
export const PRIMARY_TABS: readonly CapabilityTab['key'][] = ['agent'];

/**
 * The capability libraries that moved to the account-level `/admin` dashboard
 * (Marko, 2026-10-24: authorization is per-agent, so Customize is agent-
 * centric — you add a connector, skill, trigger, reminder, model or secret TO
 * an agent, never standalone). Customize no longer lists these as tabs or
 * sidebar rows. It keeps Agents (the primary surface), Repo, Review and
 * Settings; what an agent draws on is configured per agent, on the agent's own
 * page.
 *
 * Their standalone pages still RESOLVE by URL — `capabilityAccess()` keeps the
 * keys, so `CapabilityAccessGate` renders them and the `/customize` redirect
 * still works. Only the two nav surfaces (`CapabilityTabs`,
 * `ProjectCapabilityNav`) drop them, through `customizeNavTabs`.
 */
export const ADMIN_MANAGED_TABS: readonly CapabilityTab['key'][] = [
  'skills',
  'connectors',
  'triggers',
  'reminders',
  'models',
  'secrets',
];

/** Tabs that moved INTO Settings (Marko, 2026-10-24): Repo and Review are
 *  reachable from the Settings rail (Repositories, Review), so Customize no
 *  longer lists them as top-level tabs. */
export const SETTINGS_MANAGED_TABS: readonly CapabilityTab['key'][] = ['files', 'review'];

/** The capability tabs Customize still lists, in bar order: the caller's
 *  allowed tabs minus the libraries that moved to `/admin` and the ones that
 *  moved into Settings. Customize is agent-centric, so the bar leads with
 *  Agents; the rest is configured per agent or under `/admin` / Settings. */
export function customizeNavTabs(
  tabs: readonly CapabilityTab['key'][],
): CapabilityTab['key'][] {
  return tabs.filter(
    (key) => !ADMIN_MANAGED_TABS.includes(key) && !SETTINGS_MANAGED_TABS.includes(key),
  );
}

/**
 * A tab's URL segment. Keys are stable identifiers used across the app
 * (`TAB_PREFERENCE`, the palette, tests); segments are what a person reads in
 * the address bar. The two differ where the key predates the URL: `agent`
 * (singular key, kept so nothing keyed on it moves) lives at `agents`, and
 * `config` — named to dodge the Preferences overlay's `/settings` route back
 * when tabs sat directly under the project — lives at `settings` now that
 * every tab sits under `/customize/`.
 */
export const CAPABILITY_SEGMENT: Record<CapabilityTab['key'], string> = {
  agent: 'agents',
  skills: 'skills',
  connectors: 'connectors',
  triggers: 'triggers',
  reminders: 'reminders',
  models: 'models',
  secrets: 'secrets',
  files: 'repo',
  review: 'review',
  config: 'settings',
};

/** The root every capability tab hangs off (Marko, 2026-09-03: "always
 *  /customize/agents, /customize/skills"). */
export function customizeHref(projectId: string): string {
  return customizePath(projectId);
}

/** The tab's URL: the host's `customize` route (`setUiRoutes`) with the tab segment. */
export function capabilityTabHref(projectId: string, key: CapabilityTab['key']): string {
  return customizePath(projectId, CAPABILITY_SEGMENT[key]);
}

/**
 * A link to a capability tab from outside the customize pages (sidebar, session
 * header, hover cards). Null when the host serves no customize pages
 * (`setUiRoutes({ customize: () => null })`): the caller hides the link.
 * `capabilityTabHref` is the customize pages' own tab URL and never null.
 */
export function capabilityLinkHref(projectId: string, key: CapabilityTab['key']): string | null {
  return uiRoutes().customize(projectId, CAPABILITY_SEGMENT[key]);
}

/**
 * The Review Center: the Customize Review tab, or null when the host serves no
 * customize pages. `/projects/<id>/review`, its address from 2026-10-02 to
 * 2026-10-17, redirects here.
 */
export function reviewHref(projectId: string): string | null {
  return capabilityLinkHref(projectId, 'review');
}

/**
 * The Reminders page: the Customize Reminders tab, or null when the host
 * serves no customize pages. `/projects/<id>/reminders`, its address until
 * 2026-10-19, redirects here.
 */
export function remindersHref(projectId: string): string | null {
  return capabilityLinkHref(projectId, 'reminders');
}

/**
 * One agent's page — the configuration of a single `agents.<name>` block,
 * routed rather than modal so it has a URL a person can be sent to. The name
 * is the manifest key, which may carry characters a path segment cannot, so
 * it is encoded here and decoded in the page (`decodeURIComponent`).
 */
export function agentHref(projectId: string, agentName: string): string {
  return `${capabilityTabHref(projectId, 'agent')}/${encodeURIComponent(agentName)}`;
}

/**
 * The scope value the Connectors page reads out of `?scope=` to show Channels.
 * Exported so the three places that link to Channels — the retired
 * `/projects/<id>/channels` route, the `GRADUATED` map in `settings-tabs.ts`,
 * and the project-home setup tile — cannot drift from the page that parses it.
 */
export const CHANNELS_SCOPE = 'channels';

/**
 * Where Channels lives now: a scope of the Connectors page, not a route of its
 * own. `/projects/<id>/channels` still resolves — it redirects here — so every
 * bookmark taken while it was a tab keeps working.
 */
export function channelsHref(projectId: string): string {
  return `${capabilityTabHref(projectId, 'connectors')}?scope=${CHANNELS_SCOPE}`;
}

/**
 * The tab a pathname is on, matched against the shape `capabilityTabHref`
 * builds — `/projects/<id>/customize/<segment>` exactly — plus the deeper
 * shapes this group owns: `agentHref`'s `/projects/<id>/customize/agents/<name>`,
 * which lights the Agents tab (an agent's page is the Agents tab, opened on
 * one agent), and the app and connector pages under
 * `/projects/<id>/customize/connectors`, which light Connectors.
 *
 * The shape check is load-bearing, not defensive tidying. This used to match on
 * the LAST segment alone, which was harmless while every key was unique to this
 * route group. It stopped being harmless when Schedules and Webhooks arrived:
 * the Settings overlay is also routable, at `/projects/<id>/settings/<tab>`, so
 * a last-segment match reported `/projects/p1/settings/schedules` as the
 * Schedules capability tab and lit the sidebar's Customize row from inside
 * Settings. The agent branch is therefore keyed on the THIRD segment being
 * `agent`, never on the last one.
 */
export function activeCapabilityTab(pathname: string): CapabilityTab['key'] | null {
  const all = pathname.split('/').filter(Boolean);
  // Tolerate a leading locale segment (`/en/projects/…`): anchor on `projects`
  // wherever it sits, so the match works whether the host strips the locale or
  // not. A project id is never the literal `projects`, so the first hit is the
  // route segment.
  const start = all.indexOf('projects');
  if (start === -1) return null;
  const segments = all.slice(start);
  if (segments[0] !== 'projects' || segments[2] !== 'customize') return null;
  if (segments.length === 5 && segments[3] === CAPABILITY_SEGMENT.agent) return 'agent';
  // An app's page (`/connectors/<app>`) and a connector's page
  // (`/connectors/<app>/<connector>`) are the Connectors tab, opened on one.
  if (
    (segments.length === 5 || segments.length === 6) &&
    segments[3] === CAPABILITY_SEGMENT.connectors
  ) {
    return 'connectors';
  }
  if (segments.length !== 4) return null;
  const hit = CAPABILITY_TABS.find((t) => CAPABILITY_SEGMENT[t.key] === segments[3]);
  return hit ? hit.key : null;
}

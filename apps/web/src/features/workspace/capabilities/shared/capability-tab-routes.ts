/**
 * The capability pages that graduated out of the Customize overlay. Commands
 * was removed (its standalone page deleted) and lives only in the Customize
 * overlay again — `/customize/commands` via the `proj-commands` palette entry.
 * Order is the tab order; it is also the order the sidebar lists them in.
 *
 * Triggers graduated out of the Settings overlay, where it was two rail tabs
 * (Schedules, Webhooks) rendering one component
 * (`components/projects/schedule-view.tsx`) filtered by trigger type. It is
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
 *
 * `import type` is the ONLY import allowed for the same reason — a type
 * annotation is erased at compile time, so `FeatureFlagKey` below adds no
 * module-load side effect and the server-component rule above still holds.
 */
import type { FeatureFlagKey } from '@kortix/sdk';

export interface CapabilityTab {
  key:
    | 'agent'
    | 'connectors'
    | 'skills'
    | 'triggers'
    | 'models'
    | 'marketplace'
    | 'secrets'
    | 'review'
    | 'config';
  label: string;
  /**
   * When set, the tab exists only while this per-project feature flag is on.
   * Fail-closed: loading counts as off, so an unresolved flag hides the tab
   * rather than flashing one that 403s on click.
   *
   * A flag gate is NOT the same gate as the IAM leaf in `TAB_PREFERENCE`. The
   * leaf answers "may this member see it"; the flag answers "does this project
   * have the surface at all". Both must pass, and they fail for different
   * reasons, so they stay two fields.
   */
  flag?: FeatureFlagKey;
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
 * The standalone `/projects/<id>/config` page — a sub-nav over General /
 * Sandbox templates / Review / Feature flags / Upgrades — was retired on
 * 2026-09-02 (Jay). Its configuration sections live in the Settings overlay's
 * Workspace group (`settings/rail.ts`, opened with Cmd+, or from the
 * workspace switcher), and Review — an inbox, not configuration — moved up
 * onto this bar as its own tab. The `config` KEY stayed, trailing the bar as
 * "Settings": it is this project's own settings, distinct from the Settings
 * overlay it redirects deep-links to (`settings-tabs.ts` handles every
 * retired `/config?section=` link).
 *
 * Two tabs are flag-gated, and each says so in its own `flag:` field —
 * Review on `review_center`, Marketplace on `subprojects`.
 * `visibleCapabilityTabs` in `capability-tabs.tsx` hides a tab while its flag
 * is off; that function reads the field and knows no tab key by name.
 */
export const CAPABILITY_TABS: readonly CapabilityTab[] = [
  { key: 'agent', label: 'Agents' },
  { key: 'skills', label: 'Skills' },
  { key: 'connectors', label: 'Connectors' },
  { key: 'triggers', label: 'Triggers' },
  // Marketplace installs the four tabs above it — a subproject delivers agents,
  // skills, connectors and triggers in one commit — so it reads as the last of
  // the "what this project can do" group, ahead of Review and Secrets. Not
  // first: `CAPABILITY_TABS[0]` is the landing tab, and landing on a store
  // would answer a question nobody asked.
  { key: 'marketplace', label: 'Marketplace', flag: 'subprojects' },
  { key: 'review', label: 'Review', flag: 'review_center' },
  { key: 'models', label: 'Models' },
  { key: 'secrets', label: 'Secrets' },
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
  marketplace: 'marketplace',
  review: 'review',
  models: 'models',
  secrets: 'secrets',
  config: 'settings',
};

/** The root every capability tab hangs off (Marko, 2026-09-03: "always
 *  /customize/agents, /customize/skills"). */
export function customizeHref(projectId: string): string {
  return `/projects/${projectId}/customize`;
}

export function capabilityTabHref(projectId: string, key: CapabilityTab['key']): string {
  return `${customizeHref(projectId)}/${CAPABILITY_SEGMENT[key]}`;
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
 * builds — `/projects/<id>/customize/<segment>` exactly — plus the ONE deeper
 * shape this group owns, `agentHref`'s `/projects/<id>/customize/agents/<name>`,
 * which lights the Agents tab: an agent's page is the Agents tab, opened on
 * one agent.
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
  const segments = pathname.split('/').filter(Boolean);
  if (segments[0] !== 'projects' || segments[2] !== 'customize') return null;
  if (segments.length === 5 && segments[3] === CAPABILITY_SEGMENT.agent) return 'agent';
  if (segments.length !== 4) return null;
  const hit = CAPABILITY_TABS.find((t) => CAPABILITY_SEGMENT[t.key] === segments[3]);
  return hit ? hit.key : null;
}

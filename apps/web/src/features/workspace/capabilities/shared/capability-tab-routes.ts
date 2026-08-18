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
 * No `icon` field on purpose: the bar renders labels only, and a shape carrying
 * an icon that nothing draws is a field that goes stale unnoticed.
 */
export interface CapabilityTab {
  key:
    | 'agent'
    | 'connectors'
    | 'skills'
    | 'triggers'
    | 'models'
    | 'secrets'
    | 'members'
    | 'config';
  label: string;
}

/**
 * This array is the tab order, the sidebar order, and — via the first entry
 * the caller may read — the landing tab. `TAB_PREFERENCE` in
 * `project-sidebar/project-settings-nav.tsx` mirrors it and is asserted
 * against it, so reordering here moves the landing tab too.
 *
 * The Agents key is singular because a key IS its URL segment
 * (`/projects/<id>/agent`); only the label is plural.
 *
 * Settings' key is `config`, not `settings`, and the mismatch is deliberate:
 * `/projects/<id>/settings` already belongs to the Settings OVERLAY's
 * deep-link route, which opens the store and bounces. Two routes cannot share
 * one segment, so the tab that holds project configuration takes `config` and
 * keeps the label a person reads. Every retired `/settings/<tab>` bookmark
 * redirects here through `settings-tabs.ts`'s `GRADUATED` map.
 */
export const CAPABILITY_TABS: readonly CapabilityTab[] = [
  { key: 'models', label: 'Models' },
  { key: 'connectors', label: 'Connectors' },
  { key: 'agent', label: 'Agents' },
  { key: 'skills', label: 'Skills' },
  { key: 'triggers', label: 'Triggers' },
  { key: 'secrets', label: 'Secrets' },
  { key: 'members', label: 'Members' },
  { key: 'config', label: 'Settings' },
];

export function capabilityTabHref(projectId: string, key: CapabilityTab['key']): string {
  return `/projects/${projectId}/${key}`;
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
 * builds — `/projects/<id>/<key>` exactly, nothing deeper.
 *
 * The shape check is load-bearing, not defensive tidying. This used to match on
 * the LAST segment alone, which was harmless while every key was unique to this
 * route group. It stopped being harmless when Schedules and Webhooks arrived:
 * the Settings overlay is also routable, at `/projects/<id>/settings/<tab>`, so
 * a last-segment match reported `/projects/p1/settings/schedules` as the
 * Schedules capability tab and lit the sidebar's Customize row from inside
 * Settings.
 */
export function activeCapabilityTab(pathname: string): CapabilityTab['key'] | null {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length !== 3 || segments[0] !== 'projects') return null;
  const hit = CAPABILITY_TABS.find((t) => t.key === segments[2]);
  return hit ? hit.key : null;
}

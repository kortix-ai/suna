import {
  CAPABILITY_TABS,
  capabilityTabHref,
  channelsHref,
  type CapabilityTab,
} from '@/features/workspace/capabilities/shared/capability-tab-routes';
import type { SettingsTab } from '@/features/workspace/settings/settings-tabs';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import type { ProjectSetupStepKey } from './setup-steps';

export type SetupTile = {
  /**
   * Stable identity, independent of the display copy. The checklist's
   * completion probe keys off this — see `ProjectSetupStepKey`.
   */
  key: ProjectSetupStepKey;
  title: string;
  desc: string;
  // Every tile is a route now. Agents, Connectors, Skills and Triggers are
  // capability tabs of their own (`capabilities/capability-tab-routes.ts`);
  // anything else is a tab of the Settings overlay (`settings/settings-tabs.ts`),
  // reached through its `/projects/<id>/settings/<tab>` deep-link route.
  //
  // A tile is routed by `href` if it has one, then by `isCapabilityTabKey`,
  // then by overlay tab — so a key must be spelled exactly as its URL segment.
  section: SettingsTab | CapabilityTab['key'];
  /**
   * The exact destination, for a tile whose target is not a bare route.
   * Slack needs it because Channels is a SCOPE of the Connectors page now
   * (`?scope=channels`), and neither route builder emits a query — the tile
   * would otherwise open the connector catalogue, the right page but the
   * wrong half of it. "Your team" needs it because Members graduated out of
   * the project into the account hub's Access tab
   * (`/accounts/<id>?tab=access-projects&project=<id>`), which needs the
   * project's `account_id` — not a value either route builder below can
   * produce. Returning `undefined` means "not ready yet" (account_id still
   * loading): the tile does nothing rather than navigating to a broken URL.
   */
  href?: (projectId: string, accountId?: string) => string | undefined;
  /**
   * Every IAM leaf the tile's destination asserts. ALL of them must be allowed
   * or the tile is not rendered — hidden, never disabled, because a control a
   * person can press and only then be told "forbidden" is worse than no
   * control at all.
   *
   * Five of the six land inside the Customize surface, so they carry
   * `project.customize.read` (the leaf the whole surface is gated on — see
   * `project-sidebar/project-settings-nav.tsx`) PLUS the page's own read leaf,
   * because a custom role can hold the surface and still have one capability
   * deactivated. "Your team" is the exception: it leaves the project entirely
   * for the account hub's Access tab, which renders read-only for anyone who
   * can read the project's member list, so it gates on
   * `project.members.read` alone (see `components/iam/access-projects-tab.tsx`,
   * where every write control probes `project.members.manage` separately).
   */
  actions: readonly string[];
};

export const isCapabilityTabKey = (
  section: SetupTile['section'],
): section is CapabilityTab['key'] => CAPABILITY_TABS.some((tab) => tab.key === section);

/** Static navigation does not fetch counts before the user opens Customize. */
export const PROJECT_SETUP_TILES: SetupTile[] = [
  {
    key: 'connectors',
    title: 'Connect a tool',
    desc: 'Connect tools your agent can act in.',
    section: 'connectors',
    actions: [PROJECT_ACTIONS.PROJECT_CUSTOMIZE_READ, PROJECT_ACTIONS.PROJECT_CONNECTOR_READ],
  },
  {
    key: 'triggers',
    title: 'Schedule a trigger',
    desc: 'Run work on a repeating schedule, or when another app sends a signal.',
    section: 'triggers',
    actions: [PROJECT_ACTIONS.PROJECT_CUSTOMIZE_READ, PROJECT_ACTIONS.PROJECT_TRIGGER_READ],
  },
  {
    key: 'skills',
    title: 'Add a skill',
    desc: 'Repeatable workflows your agent reuses.',
    section: 'skills',
    actions: [PROJECT_ACTIONS.PROJECT_CUSTOMIZE_READ, PROJECT_ACTIONS.PROJECT_SKILL_READ],
  },
  {
    key: 'slack',
    title: 'Connect Slack',
    desc: 'Run this project right from chat.',
    section: 'connectors',
    href: channelsHref,
    // Channels is a SCOPE of the Connectors page, so it asserts exactly what
    // the Connectors tile above asserts — same page, same leaves.
    actions: [PROJECT_ACTIONS.PROJECT_CUSTOMIZE_READ, PROJECT_ACTIONS.PROJECT_CONNECTOR_READ],
  },
  {
    key: 'team',
    title: 'Invite your team',
    desc: 'Invite people to run and review work.',
    // Members graduated into the account hub's Access tab — this tile always
    // routes through `href` (below), which needs the project's `account_id`.
    // `section` is unused for this tile but still has to satisfy the type;
    // 'general' is an arbitrary valid placeholder, never read.
    section: 'workspace',
    href: (projectId, accountId) =>
      accountId ? `/accounts/${accountId}?tab=access-projects&project=${projectId}` : undefined,
    actions: [PROJECT_ACTIONS.PROJECT_MEMBERS_READ],
  },
  {
    key: 'agent',
    title: 'Set up your agent',
    desc: 'Shape how your agent thinks and acts.',
    // 'agent' (the route segment), not the old 'agents' overlay section —
    // `isCapabilityTabKey` matches on the key, so the wrong spelling would
    // silently fall through to the Settings tab and land on its default
    // section instead of Agents.
    section: 'agent',
    actions: [PROJECT_ACTIONS.PROJECT_CUSTOMIZE_READ, PROJECT_ACTIONS.PROJECT_AGENT_READ],
  },
];

/**
 * Every distinct leaf the tiles above name, deduped and module-level so its
 * identity is stable — `useProjectCans` keys its query on the action list and
 * would refetch on each render otherwise.
 */
export const PROJECT_SETUP_TILE_ACTIONS: readonly string[] = [
  ...new Set(PROJECT_SETUP_TILES.flatMap((tile) => tile.actions)),
];

/**
 * The tile's destination, resolved during render so the row can be an anchor
 * Next prefetches rather than a click handler it cannot see into.
 *
 * `undefined` only for "Invite your team", and only while `account_id` is
 * still in flight — the row keeps its place and carries no anchor yet.
 */
export function setupTileHref(
  tile: SetupTile,
  projectId: string,
  accountId?: string,
): string | undefined {
  if (tile.href) return tile.href(projectId, accountId);
  return isCapabilityTabKey(tile.section)
    ? capabilityTabHref(projectId, tile.section)
    : `/projects/${projectId}/settings/${tile.section}`;
}

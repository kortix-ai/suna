/**
 * Customize section identifiers + helpers.
 *
 * The /workspaces/[id]/customize page reads its active section from either the
 * path segment (`/customize/agents`) or the legacy `?section=` query param.
 * This module keeps the section enum, the default, and a parser in one spot
 * so the page, the sidebar, and any deep-link helpers all agree on the
 * canonical list.
 *
 * Files, Agents, Connectors, and Skills are NOT customize sections — they are
 * standalone `/workspaces/[id]/<section>` pages (any member can browse Files;
 * Agents/Connectors/Skills gate on their own read leaf — see
 * capabilities/capability-tab-routes.ts). Commands is the one that came BACK:
 * its standalone page was deleted (#6169), so it lives in this overlay and its
 * deep link opens here rather than redirecting. Deep-link routes still accept
 * the legacy section names and redirect them where applicable.
 */

export type CustomizeSection =
  | 'git'
  | 'review'
  | 'commands'
  | 'marketplace'
  | 'secrets'
  | 'llm-management'
  | 'llm-overview'
  | 'llm-providers'
  | 'llm-logs'
  | 'llm-budgets'
  | 'llm-keys'
  | 'llm-api'
  | 'members'
  | 'schedules'
  | 'webhooks'
  | 'channels'
  | 'voice'
  | 'sandbox'
  | 'settings'
  | 'feature-flags'
  | 'upgrade';

/**
 * The default must be a section that is actually in the rail with every flag
 * off, or the overlay opens on nothing. Agents graduated to its own route, so
 * this moved off `agents`; Secrets is what the overlay is most often opened
 * for and it survives every flag.
 */
export const DEFAULT_CUSTOMIZE_SECTION: CustomizeSection = 'secrets';

export const CUSTOMIZE_SECTIONS: readonly CustomizeSection[] = [
  'git',
  'review',
  'commands',
  'marketplace',
  'secrets',
  'llm-management',
  'llm-overview',
  'llm-providers',
  'llm-logs',
  'llm-budgets',
  'llm-keys',
  'llm-api',
  'members',
  'schedules',
  'webhooks',
  'channels',
  'voice',
  'sandbox',
  'settings',
  'feature-flags',
  'upgrade',
];

/**
 * Sections that graduated out of the Customize overlay into their own routes.
 * Deep links and bookmarks into `/customize/<section>` land on the new page
 * instead of opening the overlay.
 */
const GRADUATED: Record<string, (workspaceId: string) => string> = {
  files: (p) => `/workspaces/${p}/files`,
  changes: (p) => `/workspaces/${p}/files?panel=proposed-changes`,
  // The overlay section was `agents`; the route segment is `agent`. Both
  // spellings redirect, because every bookmark and stale href in the wild
  // points at the plural one.
  agent: (p) => `/workspaces/${p}/agent`,
  agents: (p) => `/workspaces/${p}/agent`,
  connectors: (p) => `/workspaces/${p}/connectors`,
  computers: (p) => `/workspaces/${p}/connectors`,
  skills: (p) => `/workspaces/${p}/skills`,
};

export function legacyCustomizeRedirect(
  workspaceId: string,
  rawSection: string | null | undefined,
): string | null {
  if (!rawSection) return null;
  const build = GRADUATED[rawSection];
  return build ? build(workspaceId) : null;
}

export function parseCustomizeSection(raw: string | null | undefined): CustomizeSection | null {
  if (!raw) return null;
  return (CUSTOMIZE_SECTIONS as readonly string[]).includes(raw) ? (raw as CustomizeSection) : null;
}

/** Whether an href matching `/customize(/<segment>)?` should open the overlay. */
export type CustomizeOverlayMatch =
  | { opensOverlay: true; section: CustomizeSection | undefined }
  | { opensOverlay: false };

/**
 * Decide whether a menu-registry href should open the Customize overlay, and
 * on which section — the command palette's only use of this is a pure lookup,
 * so it is extracted here to be unit-tested without mounting the palette.
 *
 * A bare `/customize` (no segment) opens the overlay on its default section.
 * A named segment only opens the overlay when it resolves through
 * `parseCustomizeSection` to a REAL overlay section. Connectors and Skills
 * graduated out of `CustomizeSection`, so a stale `/customize/skills`
 * href (or any other unresolvable segment) must NOT open the overlay —
 * `openCustomize(undefined)` would otherwise silently reopen it on whatever
 * section the user last viewed instead of navigating anywhere. The caller is
 * expected to fall through to a normal `router.push(href)` when this returns
 * `{ opensOverlay: false }`.
 */
export function resolveCustomizeOverlayHref(href: string): CustomizeOverlayMatch {
  const match = href.match(/\/customize(?:\/([^/?#]+))?/);
  if (!match) return { opensOverlay: false };
  if (!match[1]) return { opensOverlay: true, section: undefined };
  const section = parseCustomizeSection(match[1]);
  return section ? { opensOverlay: true, section } : { opensOverlay: false };
}

import { capabilityPagesEnabled, isCapabilitySection } from '@/lib/capability-pages';

/**
 * Customize section identifiers + helpers.
 *
 * The /projects/[id]/customize page reads its active section from either the
 * path segment (`/customize/agents`) or the legacy `?section=` query param.
 * This module keeps the section enum, the default, and a parser in one spot
 * so the page, the sidebar, and any deep-link helpers all agree on the
 * canonical list.
 *
 * Files, Connectors, Skills, and Commands are NOT customize sections — they
 * are standalone `/projects/[id]/<section>` pages (any member can browse
 * Files; Connectors/Skills/Commands gate on their own read leaf — see
 * capabilities/tabs.ts). Deep-link routes still accept the legacy section
 * names and redirect there.
 */

export type CustomizeSection =
  | 'git'
  | 'review'
  | 'agents'
  // Connectors/Skills/Commands are overlay sections again while the standalone
  // capability pages (#6054) are behind NEXT_PUBLIC_CAPABILITY_PAGES. With the
  // flag ON they are still reachable here — the deep link just redirects out.
  | 'connectors'
  | 'skills'
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
  | 'computers'
  | 'members'
  | 'schedules'
  | 'webhooks'
  | 'channels'
  | 'voice'
  | 'sandbox'
  | 'settings'
  | 'upgrade';

export const DEFAULT_CUSTOMIZE_SECTION: CustomizeSection = 'agents';

export const CUSTOMIZE_SECTIONS: readonly CustomizeSection[] = [
  'git',
  'review',
  'agents',
  'connectors',
  'skills',
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
  'computers',
  'members',
  'schedules',
  'webhooks',
  'channels',
  'voice',
  'sandbox',
  'settings',
  'upgrade',
];

/**
 * Sections that graduated out of the Customize overlay into their own routes.
 * Deep links and bookmarks into `/customize/<section>` land on the new page
 * instead of opening the overlay.
 */
const GRADUATED: Record<string, (projectId: string) => string> = {
  files: (p) => `/projects/${p}/files`,
  changes: (p) => `/projects/${p}/files?panel=proposed-changes`,
};

/**
 * Graduated only while the capability pages are enabled (#6054).
 *
 * Files and Changes left the overlay in an earlier, unrelated change and always
 * redirect. These two are the ones the flag governs: with it OFF the deep link
 * must fall through and open the overlay, which is where they live again.
 * Commands had a standalone page under #6054 too, but that page was removed;
 * it stays in the overlay permanently and is intentionally NOT listed here, so
 * a `/customize/commands` deep link never bounces to a dead route.
 */
const GRADUATED_BEHIND_FLAG: Record<string, (projectId: string) => string> = {
  connectors: (p) => `/projects/${p}/connectors`,
  skills: (p) => `/projects/${p}/skills`,
};

export function legacyCustomizeRedirect(
  projectId: string,
  rawSection: string | null | undefined,
): string | null {
  if (!rawSection) return null;
  const build =
    GRADUATED[rawSection] ??
    (capabilityPagesEnabled() ? GRADUATED_BEHIND_FLAG[rawSection] : undefined);
  return build ? build(projectId) : null;
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
 * `parseCustomizeSection` to a REAL overlay section. Connectors/Skills/
 * Commands graduated out of `CustomizeSection`, so a stale `/customize/skills`
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
  if (!section) return { opensOverlay: false };
  // Connectors/Skills/Commands are overlay sections only while the standalone
  // capability pages are flagged off (#6054). With the flag ON the caller must
  // fall through to a normal navigation so the deep-link route can forward to
  // the real page, instead of the palette opening an overlay section that is
  // no longer where those live.
  if (isCapabilitySection(section) && capabilityPagesEnabled()) return { opensOverlay: false };
  return { opensOverlay: true, section };
}

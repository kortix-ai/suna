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
  connectors: (p) => `/projects/${p}/connectors`,
  skills: (p) => `/projects/${p}/skills`,
  commands: (p) => `/projects/${p}/commands`,
};

export function legacyCustomizeRedirect(
  projectId: string,
  rawSection: string | null | undefined,
): string | null {
  if (!rawSection) return null;
  const build = GRADUATED[rawSection];
  return build ? build(projectId) : null;
}

export function parseCustomizeSection(raw: string | null | undefined): CustomizeSection | null {
  if (!raw) return null;
  return (CUSTOMIZE_SECTIONS as readonly string[]).includes(raw) ? (raw as CustomizeSection) : null;
}

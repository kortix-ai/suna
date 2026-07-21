/**
 * Customize section identifiers + helpers.
 *
 * The /projects/[id]/customize page reads its active section from either the
 * path segment (`/customize/skills`) or the legacy `?section=` query param.
 * This module keeps the section enum, the default, and a parser in one spot
 * so the page, the sidebar, and any deep-link helpers all agree on the
 * canonical list.
 *
 * Files is NOT a customize section — it's the standalone /projects/[id]/files
 * page (any member can browse it). Deep-link routes still accept the legacy
 * `files` section and redirect there.
 */

export type CustomizeSection =
  | 'git'
  | 'review'
  | 'skills'
  | 'agents'
  | 'marketplace'
  | 'secrets'
  | 'connectors'
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
  | 'meet'
  | 'sandbox'
  | 'settings'
  | 'upgrade';

export const DEFAULT_CUSTOMIZE_SECTION: CustomizeSection = 'agents';

export const CUSTOMIZE_SECTIONS: readonly CustomizeSection[] = [
  'git',
  'review',
  'skills',
  'agents',
  'marketplace',
  'secrets',
  'connectors',
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
  'meet',
  'sandbox',
  'settings',
  'upgrade',
];

export function legacyCustomizeFilesRedirect(
  projectId: string,
  rawSection: string | null | undefined,
): string | null {
  if (rawSection === 'files') return `/projects/${projectId}/files`;
  if (rawSection === 'changes') {
    return `/projects/${projectId}/files?panel=proposed-changes`;
  }
  return null;
}

export function parseCustomizeSection(raw: string | null | undefined): CustomizeSection | null {
  if (!raw) return null;
  return (CUSTOMIZE_SECTIONS as readonly string[]).includes(raw) ? (raw as CustomizeSection) : null;
}

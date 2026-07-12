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
  | 'changes'
  | 'review'
  | 'skills'
  | 'agents'
  | 'commands'
  | 'marketplace'
  | 'secrets'
  | 'connectors'
  | 'llm-management'
  | 'llm-overview'
  | 'llm-providers'
  | 'llm-logs'
  | 'llm-budgets'
  | 'llm-keys'
  | 'computers'
  | 'members'
  | 'schedules'
  | 'webhooks'
  | 'channels'
  | 'meet'
  | 'sandbox'
  | 'dev'
  | 'settings'
  | 'upgrade';

export const DEFAULT_CUSTOMIZE_SECTION: CustomizeSection = 'agents';

export const CUSTOMIZE_SECTIONS: readonly CustomizeSection[] = [
  'changes',
  'review',
  'skills',
  'agents',
  'commands',
  'marketplace',
  'secrets',
  'connectors',
  'llm-management',
  'llm-overview',
  'llm-providers',
  'llm-logs',
  'llm-budgets',
  'llm-keys',
  'computers',
  'members',
  'schedules',
  'webhooks',
  'channels',
  'meet',
  'sandbox',
  'dev',
  'settings',
  'upgrade',
];

export function parseCustomizeSection(raw: string | null | undefined): CustomizeSection | null {
  if (!raw) return null;
  return (CUSTOMIZE_SECTIONS as readonly string[]).includes(raw) ? (raw as CustomizeSection) : null;
}

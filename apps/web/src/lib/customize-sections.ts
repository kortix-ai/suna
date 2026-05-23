/**
 * Customize section identifiers + helpers.
 *
 * The /projects/[id]/customize page reads its active section from either the
 * path segment (`/customize/skills`) or the legacy `?section=` query param.
 * This module keeps the section enum, the default, and a parser in one spot
 * so the page, the sidebar, and any deep-link helpers all agree on the
 * canonical list.
 */

export type CustomizeSection =
  | 'files'
  | 'skills'
  | 'agents'
  | 'commands'
  | 'secrets'
  | 'members'
  | 'schedules'
  | 'webhooks'
  | 'channels'
  | 'settings';

export const DEFAULT_CUSTOMIZE_SECTION: CustomizeSection = 'files';

export const CUSTOMIZE_SECTIONS: readonly CustomizeSection[] = [
  'files',
  'skills',
  'agents',
  'commands',
  'secrets',
  'members',
  'schedules',
  'webhooks',
  'channels',
  'settings',
];

export function parseCustomizeSection(raw: string | null | undefined): CustomizeSection | null {
  if (!raw) return null;
  return (CUSTOMIZE_SECTIONS as readonly string[]).includes(raw)
    ? (raw as CustomizeSection)
    : null;
}

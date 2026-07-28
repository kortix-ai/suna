/**
 * The project navigation model: four flat sections plus one Settings surface,
 * and the compatibility layer that keeps every legacy Customize deep link alive.
 *
 * Customize used to be a full-screen overlay with a four-group rail and 24
 * sections. Those 24 identifiers still exist as {@link CustomizeSection} — they
 * remain the key type of `CUSTOMIZE_SECTION_ACCESS` in `lib/project-actions`,
 * so the IAM model is untouched. What changes is where each one *renders*:
 * real routes instead of an overlay.
 *
 * {@link resolveLegacyCustomizeHref} is exhaustive over all 24. That
 * exhaustiveness is the "no functionality was removed" guarantee, and
 * `project-nav.test.ts` fails loudly if anyone adds a section without giving it
 * a home.
 */

import {
  CUSTOMIZE_SECTIONS,
  type CustomizeSection,
  legacyCustomizeFilesRedirect,
} from '@/lib/customize-sections';

export { legacyCustomizeFilesRedirect };

/* ─── The four ──────────────────────────────────────────────────────────── */

export type ProjectNavKey = 'connectors' | 'skills' | 'automations' | 'agents';

export interface ProjectNavItem {
  key: ProjectNavKey;
  label: string;
  /** Path segment under /projects/[id]/. */
  segment: string;
  /**
   * The legacy section this route gates on. Access is still resolved through
   * `CUSTOMIZE_SECTION_ACCESS`, so promoting a section to a route does not
   * change who can see it.
   */
  gateSection: CustomizeSection;
}

export const PROJECT_NAV_ITEMS: readonly ProjectNavItem[] = [
  { key: 'connectors', label: 'Connectors', segment: 'connectors', gateSection: 'connectors' },
  { key: 'skills', label: 'Skills', segment: 'skills', gateSection: 'skills' },
  { key: 'automations', label: 'Automations', segment: 'automations', gateSection: 'schedules' },
  { key: 'agents', label: 'Agents', segment: 'agents', gateSection: 'agents' },
];

/* ─── Settings ──────────────────────────────────────────────────────────── */

export type ProjectSettingsTab =
  | 'general'
  | 'members'
  | 'environment'
  | 'repository'
  | 'sandbox'
  | 'models'
  | 'upgrades';

export interface ProjectSettingsTabItem {
  key: ProjectSettingsTab;
  label: string;
  gateSection: CustomizeSection;
}

export const PROJECT_SETTINGS_TABS: readonly ProjectSettingsTabItem[] = [
  { key: 'general', label: 'General', gateSection: 'settings' },
  { key: 'members', label: 'Members', gateSection: 'members' },
  { key: 'environment', label: 'Environment', gateSection: 'secrets' },
  { key: 'repository', label: 'Repository', gateSection: 'git' },
  { key: 'sandbox', label: 'Sandbox', gateSection: 'sandbox' },
  { key: 'models', label: 'Models', gateSection: 'llm-management' },
  { key: 'upgrades', label: 'Upgrades', gateSection: 'upgrade' },
];

export const DEFAULT_PROJECT_SETTINGS_TAB: ProjectSettingsTab = 'general';

/** Every first path segment a section can resolve to. */
export const PROJECT_ROUTE_SEGMENTS: readonly string[] = [
  'connectors',
  'skills',
  'automations',
  'agents',
  'settings',
  'marketplace',
  'review',
  'files',
];

/* ─── Legacy resolution ─────────────────────────────────────────────────── */

/** Sub-state a legacy section carried in the overlay store, now query params. */
export interface LegacyCustomizeOptions {
  /** `membersTab` from the old customize store — only 'invite' is meaningful. */
  membersTab?: string | null;
}

export function projectSettingsHref(projectId: string, tab: ProjectSettingsTab): string {
  return `/projects/${projectId}/settings/${tab}`;
}

export function projectNavHref(projectId: string, key: ProjectNavKey): string {
  const item = PROJECT_NAV_ITEMS.find((i) => i.key === key);
  return `/projects/${projectId}/${item?.segment ?? key}`;
}

/**
 * Where a legacy Customize section lives now.
 *
 * Returns `null` only for an unrecognised string, so callers can fall through
 * to their own default. Every real {@link CustomizeSection} resolves — see the
 * exhaustiveness test.
 *
 * `files` and `changes` are not sections; they were always redirects, and they
 * keep going through {@link legacyCustomizeFilesRedirect} unchanged.
 */
export function resolveLegacyCustomizeHref(
  projectId: string,
  rawSection: string | null | undefined,
  options: LegacyCustomizeOptions = {},
): string | null {
  const filesRedirect = legacyCustomizeFilesRedirect(projectId, rawSection);
  if (filesRedirect) return filesRedirect;
  if (!rawSection) return null;

  const base = `/projects/${projectId}`;
  const section = rawSection as CustomizeSection;
  if (!CUSTOMIZE_SECTIONS.includes(section)) return null;

  // ONE surface. Every section lives in the Customize rail again, so this is a
  // path join rather than a per-section table.
  //
  // The table it replaces mapped each section onto one of eight promoted
  // routes, and that mapping is where the dead links came from: `?group=`
  // params nothing read, sections folded into screens that did not render
  // them, and Computers with no route in at all. A section cannot be
  // mis-filed if there is only one place to file it.
  const href = `${base}/customize/${section}`;
  if (section === 'members' && options.membersTab === 'invite') return `${href}?tab=invite`;
  return href;
}

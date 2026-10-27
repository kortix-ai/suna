import {
  AlarmIcon,
  AppWindowIcon,
  BookOpenTextIcon,
  CpuIcon,
  FoldersIcon,
  KeyIcon,
  PlugsConnectedIcon,
  TimerIcon,
  type Icon,
} from '@phosphor-icons/react';

import type { CapabilityTab } from '../../internal/lib/capability-tab-routes';
import { adminPath } from '../../lib/routes';
import {
  parseProjectSettingsSection,
  type ProjectSettingsSectionKey,
} from '../../customize/project-settings/project-settings-sections';

/**
 * The sections of Project admin (`/projects/<id>/admin`).
 *
 * Customize is agent-first: each agent's page configures what THAT agent draws
 * on. Project admin is the other view: the project-wide libraries an agent is
 * granted from, plus every project setting. Two rail groups:
 *
 *  1. **Project resources** — the global variant of each library page.
 *  2. **Settings** — the sections of `project-settings-sections.ts`, unchanged.
 *
 * A key IS its URL segment (`/admin/<key>`), so renaming one breaks live links. The
 * settings keys are the Settings page's own keys, so `?section=git` means the
 * same section on both surfaces.
 */
export type ProjectAdminResourceKey =
  | 'connectors'
  | 'skills'
  | 'triggers'
  | 'loops'
  | 'models'
  | 'secrets'
  | 'apps'
  | 'repo';

/**
 * The Settings sections this page lists. Review is not one: it is its own
 * standalone surface, and `projectSettingsSections` never lists it.
 */
export type ProjectAdminSettingsKey = Exclude<ProjectSettingsSectionKey, 'review'>;

export type ProjectAdminSectionKey = ProjectAdminResourceKey | ProjectAdminSettingsKey;

export interface ProjectAdminResource {
  key: ProjectAdminResourceKey;
  icon: Icon;
  /**
   * The Customize tab whose access rule (`capabilityAccess`) decides whether
   * the row shows. Null: the page gates itself (Apps reads `useProjectCan`).
   */
  capability: CapabilityTab['key'] | null;
  /**
   * The page lives in the host app, not in `@kortix/ui`: the host passes it
   * through `hostSections`, and the row hides when it does not.
   */
  host: boolean;
  /**
   * The flag the row needs. Repo is a library only with `drives` on; with it
   * off, the sidebar's Files row is the repo browser (`projectNavRows`).
   */
  flag?: 'drives';
}

/** Rail order. Icons match the agent editor's tabs (`agent-page.tsx`). */
export const PROJECT_ADMIN_RESOURCES: readonly ProjectAdminResource[] = [
  { key: 'connectors', icon: PlugsConnectedIcon, capability: 'connectors', host: false },
  { key: 'skills', icon: BookOpenTextIcon, capability: 'skills', host: false },
  { key: 'triggers', icon: TimerIcon, capability: 'triggers', host: false },
  { key: 'loops', icon: AlarmIcon, capability: 'reminders', host: true },
  { key: 'models', icon: CpuIcon, capability: 'models', host: false },
  { key: 'secrets', icon: KeyIcon, capability: 'secrets', host: false },
  { key: 'apps', icon: AppWindowIcon, capability: null, host: true },
  { key: 'repo', icon: FoldersIcon, capability: 'files', host: false, flag: 'drives' },
];

/** `/projects/<id>/admin` with no section opens the first resource. */
export const DEFAULT_PROJECT_ADMIN_SECTION: ProjectAdminSectionKey = 'connectors';

export function isProjectAdminResource(key: ProjectAdminSectionKey): key is ProjectAdminResourceKey {
  return PROJECT_ADMIN_RESOURCES.some((r) => r.key === key);
}

export function parseProjectAdminSection(
  raw: string | null | undefined,
): ProjectAdminSectionKey | null {
  if (!raw) return null;
  const resource = PROJECT_ADMIN_RESOURCES.find((r) => r.key === raw);
  if (resource) return resource.key;
  const setting = parseProjectSettingsSection(raw);
  return setting === 'review' ? null : setting;
}

/**
 * The link to one section: `/projects/<id>/admin/<section>`. `extra` adds page
 * params (`scope=channels` for the Connectors page's Channels scope).
 */
export function projectAdminHref(
  projectId: string,
  key: ProjectAdminSectionKey = DEFAULT_PROJECT_ADMIN_SECTION,
  extra?: Record<string, string>,
): string {
  const query = new URLSearchParams(extra).toString();
  return `${adminPath(projectId, key)}${query ? `?${query}` : ''}`;
}

/**
 * The section a legacy settings-nav id names. Panes still call
 * `navigate('llm-providers')`, `navigate('experimental')` or
 * `navigate('channels')` in the overlay's vocabulary; inside Project admin
 * each of those lands on a section of this page. Null: the id is not a
 * section here (`members`, `review`, a personal overlay tab).
 */
export function projectAdminNavTarget(tab: string): ProjectAdminSectionKey | null {
  const direct = parseProjectAdminSection(tab);
  if (direct) return direct;
  if (tab.startsWith('llm-')) return 'models';
  if (tab === 'channels') return 'connectors';
  if (tab === 'reminders') return 'loops';
  if (tab === 'settings' || tab === 'workspace') return 'general';
  if (tab === 'experimental') return 'feature-flags';
  if (tab === 'snapshots') return 'sandbox';
  return null;
}

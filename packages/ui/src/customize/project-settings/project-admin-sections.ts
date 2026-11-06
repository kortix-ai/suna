import {
  AppWindowIcon,
  BookOpenTextIcon,
  CpuIcon,
  FoldersIcon,
  HardDrivesIcon,
  KeyIcon,
  PlugsConnectedIcon,
  TimerIcon,
  type Icon,
} from '@phosphor-icons/react';

import {
  WORKSPACE_SETTINGS_GROUPS as REGISTRY_GROUPS,
  parseWorkspaceSettingsSection,
  type WorkspaceSettingsGroup,
  type WorkspaceSettingsSection,
} from '@kortix/shared/workspace-settings';

import type { AccountSection } from '../../internal/account-hub/sections';
import type { CapabilityTab } from '../../internal/lib/capability-tab-routes';
import { adminPath } from '../../lib/routes';
import { type ProjectSettingsSectionKey } from './project-settings-sections';

/**
 * The sections of Workspace settings (`/workspaces/<id>/admin/<section>`), the
 * one Settings panel per workspace (design.md §3.2 C7). The order, the groups,
 * the old ids and the English labels come from one registry,
 * `@kortix/shared/workspace-settings`, which the CLI, the API emails and the
 * My Kortix prompt read too. This file adds what only the web panel needs:
 * which pane renders a section, and the library rows' capability gates.
 *
 *  1. **Workspace** — General (name, icon, workspace id, Danger zone),
 *     Security (MFA, session policy, key policy, oversight), Branding, Git,
 *     Sandbox, Feature flags, API keys, Capture (while Capture is on).
 *  2. **Library** — the global variant of each library page.
 *  3. **People** — Members (one roster, one role per person), Groups, Roles,
 *     Identity, Audit log.
 *  4. **Billing** — Plan, Usage.
 *  5. **Support** — Help.
 *
 * A key IS its URL segment (`/admin/<key>`), so renaming one breaks live links:
 * rename it in the registry, which keeps the old id as an alias.
 */
export type ProjectAdminSectionKey = WorkspaceSettingsSection;

export type ProjectAdminResourceKey = Extract<
  WorkspaceSettingsSection,
  'connectors' | 'skills' | 'triggers' | 'models' | 'secrets' | 'apps' | 'drives' | 'repo'
>;

/**
 * The Settings sections this page lists. Review is not one: it is its own
 * standalone surface, and `projectSettingsSections` never lists it.
 */
export type ProjectAdminSettingsKey = Exclude<ProjectSettingsSectionKey, 'review'>;

/** The sections whose pane is a host pane of the workspace's account (`apps/web`). */
export type WorkspaceAccountSectionKey = Extract<
  WorkspaceSettingsSection,
  'security' | 'branding' | 'api-keys' | 'members' | 'groups' | 'roles' | 'identity' | 'audit' | 'help' | 'plan' | 'usage'
>;

export type WorkspaceSettingsGroupId = WorkspaceSettingsGroup;

/** The rail, in order. Each row still follows its own visibility rule. */
export const WORKSPACE_SETTINGS_GROUPS: readonly {
  id: WorkspaceSettingsGroupId;
  sections: readonly ProjectAdminSectionKey[];
}[] = REGISTRY_GROUPS;

/**
 * The account pane each workspace section shows. Git is a project section
 * that ALSO carries an account pane (the account's GitHub connections).
 */
export const ACCOUNT_TAB_FOR_SECTION: Partial<Record<ProjectAdminSectionKey, AccountSection>> = {
  security: 'settings',
  git: 'git',
  branding: 'branding',
  'api-keys': 'tokens',
  members: 'members',
  groups: 'groups',
  roles: 'roles',
  identity: 'identity',
  audit: 'audit',
  help: 'help',
  plan: 'billing',
  usage: 'transactions',
};

/**
 * Old account hub link (`?accountTab=`) → the workspace section that took it
 * over. Access merged into Members; the account Settings pane is Security.
 */
export const SECTION_FOR_ACCOUNT_TAB: Record<AccountSection, ProjectAdminSectionKey> = {
  settings: 'security',
  git: 'git',
  branding: 'branding',
  tokens: 'api-keys',
  members: 'members',
  groups: 'groups',
  'access-projects': 'members',
  roles: 'roles',
  identity: 'identity',
  audit: 'audit',
  help: 'help',
  billing: 'plan',
  transactions: 'usage',
};

const ACCOUNT_SECTION_KEYS: readonly WorkspaceAccountSectionKey[] = [
  'security',
  'branding',
  'api-keys',
  'members',
  'groups',
  'roles',
  'identity',
  'audit',
  'help',
  'plan',
  'usage',
];

export function isWorkspaceAccountSection(key: ProjectAdminSectionKey): key is WorkspaceAccountSectionKey {
  return (ACCOUNT_SECTION_KEYS as readonly string[]).includes(key);
}

/**
 * The catalog key of a section's rail label: `workspaces.settings.sections.<key>`.
 * The en catalog holds the registry's English label (`WORKSPACE_SETTINGS_LABELS`);
 * a web test keeps them equal.
 */
export function sectionLabelKey(section: ProjectAdminSectionKey): string {
  return section.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

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
  { key: 'secrets', icon: KeyIcon, capability: 'secrets', host: false },
  { key: 'skills', icon: BookOpenTextIcon, capability: 'skills', host: false },
  { key: 'drives', icon: HardDrivesIcon, capability: null, host: false, flag: 'drives' },
  { key: 'apps', icon: AppWindowIcon, capability: null, host: true },
  // Triggers: kortix.yaml triggers and runtime triggers (loops) on one page.
  // The key stays `triggers`: it is the URL segment, and live links name it.
  { key: 'triggers', icon: TimerIcon, capability: 'triggers', host: false },
  { key: 'models', icon: CpuIcon, capability: 'models', host: false },
  { key: 'repo', icon: FoldersIcon, capability: 'files', host: false, flag: 'drives' },
];

/** Sections that no longer exist here: their links open the Agents list. */
export const RETIRED_SECTIONS: readonly string[] = ['tools', 'extensions'];

/** `/workspaces/<id>/admin` with no section opens General, else the first row the caller may open. */
export const DEFAULT_PROJECT_ADMIN_SECTION: ProjectAdminSectionKey = 'general';

export function isProjectAdminResource(key: ProjectAdminSectionKey): key is ProjectAdminResourceKey {
  return PROJECT_ADMIN_RESOURCES.some((r) => r.key === key);
}

export function parseProjectAdminSection(
  raw: string | null | undefined,
): ProjectAdminSectionKey | null {
  // The registry resolves the old ids (`access`, `loops`, `settings`, …).
  // `/admin/tools` and `/admin/extensions` are not sections: the dashboard
  // sends them to the Agents list (`RETIRED_SECTIONS`).
  return parseWorkspaceSettingsSection(raw);
}

/**
 * The link to one section: `/workspaces/<id>/admin/<section>`. `extra` adds page
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
  // In the overlay vocabulary `settings` meant the project settings page.
  if (tab === 'settings') return 'general';
  const direct = parseProjectAdminSection(tab);
  // An account section id (`members`, …) means something else in the overlay
  // vocabulary (`members` is the project roster): it keeps resolving there.
  if (direct && !isWorkspaceAccountSection(direct)) return direct;
  if (tab.startsWith('llm-')) return 'models';
  if (tab === 'channels') return 'connectors';
  if (tab === 'reminders') return 'triggers';
  if (tab === 'workspace') return 'general';
  if (tab === 'experimental') return 'feature-flags';
  if (tab === 'snapshots') return 'sandbox';
  return null;
}

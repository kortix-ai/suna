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

import type { AccountSection } from '../../internal/account-hub/sections';
import type { CapabilityTab } from '../../internal/lib/capability-tab-routes';
import { adminPath } from '../../lib/routes';
import {
  parseProjectSettingsSection,
  type ProjectSettingsSectionKey,
} from './project-settings-sections';

/**
 * The sections of Workspace settings (`/workspaces/<id>/admin`), the one
 * settings surface per workspace (Workspaces ux.md section 4). It absorbed
 * the account hub's panes: a workspace is one account and its project, so
 * the account's members, roles, billing and keys are the workspace's.
 *
 * Four rail groups (`WORKSPACE_SETTINGS_GROUPS`):
 *
 *  1. **Workspace** — General (name, icon, and the account's security
 *     policy), Branding, Git repo (with the account's GitHub connections),
 *     Sandbox templates, Feature flags, API keys.
 *  2. **Library** — the global variant of each library page. Tools and
 *     Extensions have none (Jay, 2026-11-03): they are switched per agent.
 *  3. **People** — Members, Groups, Access, Roles, Identity, Audit log, Help.
 *  4. **Billing** — Plan, Usage.
 *
 * A key IS its URL segment (`/admin/<key>`), so renaming one breaks live links.
 * The settings keys are the Settings page's own keys, so `?section=git` means
 * the same section on both surfaces.
 */
export type ProjectAdminResourceKey =
  | 'connectors'
  | 'skills'
  | 'triggers'
  | 'models'
  | 'secrets'
  | 'apps'
  | 'drives'
  | 'repo';

/**
 * The Settings sections this page lists. Review is not one: it is its own
 * standalone surface, and `projectSettingsSections` never lists it.
 */
export type ProjectAdminSettingsKey = Exclude<ProjectSettingsSectionKey, 'review'>;

/** The sections whose pane is an account pane (the old account hub). */
export type WorkspaceAccountSectionKey =
  | 'branding'
  | 'api-keys'
  | 'members'
  | 'groups'
  | 'access'
  | 'roles'
  | 'identity'
  | 'audit'
  | 'help'
  | 'plan'
  | 'usage';

export type ProjectAdminSectionKey =
  | ProjectAdminResourceKey
  | ProjectAdminSettingsKey
  | WorkspaceAccountSectionKey;

export type WorkspaceSettingsGroupId = 'workspace' | 'library' | 'people' | 'billing';

/** The rail, in order. Each row still follows its own visibility rule. */
export const WORKSPACE_SETTINGS_GROUPS: readonly {
  id: WorkspaceSettingsGroupId;
  sections: readonly ProjectAdminSectionKey[];
}[] = [
  { id: 'workspace', sections: ['general', 'branding', 'git', 'sandbox', 'feature-flags', 'api-keys'] },
  { id: 'library', sections: ['connectors', 'secrets', 'skills', 'drives', 'apps', 'triggers', 'models', 'repo'] },
  { id: 'people', sections: ['members', 'groups', 'access', 'roles', 'identity', 'audit', 'help'] },
  { id: 'billing', sections: ['plan', 'usage'] },
];

/**
 * The account hub section each workspace section shows. General and Git repo
 * are project sections that ALSO carry an account pane (the account Settings
 * pane's security policy, the account's GitHub connections).
 */
export const ACCOUNT_TAB_FOR_SECTION: Partial<Record<ProjectAdminSectionKey, AccountSection>> = {
  general: 'settings',
  git: 'git',
  branding: 'branding',
  'api-keys': 'tokens',
  members: 'members',
  groups: 'groups',
  access: 'access-projects',
  roles: 'roles',
  identity: 'identity',
  audit: 'audit',
  help: 'help',
  plan: 'billing',
  usage: 'transactions',
};

/** Old account hub link (`?accountTab=`) → the workspace section that took it over. */
export const SECTION_FOR_ACCOUNT_TAB: Record<AccountSection, ProjectAdminSectionKey> = {
  settings: 'general',
  git: 'git',
  branding: 'branding',
  tokens: 'api-keys',
  members: 'members',
  groups: 'groups',
  'access-projects': 'access',
  roles: 'roles',
  identity: 'identity',
  audit: 'audit',
  help: 'help',
  billing: 'plan',
  transactions: 'usage',
};

const ACCOUNT_SECTION_KEYS: readonly WorkspaceAccountSectionKey[] = [
  'branding',
  'api-keys',
  'members',
  'groups',
  'access',
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
  if (!raw) return null;
  // `/admin/tools` and `/admin/extensions` were read-only lists until
  // 2026-11-03; the dashboard sends them to the Agents list (`RETIRED_SECTIONS`).
  // `/admin/loops` was the Loops page until 2026-10-28: loops are triggers now.
  if (raw === 'loops') return 'triggers';
  const resource = PROJECT_ADMIN_RESOURCES.find((r) => r.key === raw);
  if (resource) return resource.key;
  const account = ACCOUNT_SECTION_KEYS.find((key) => key === raw);
  if (account) return account;
  const setting = parseProjectSettingsSection(raw);
  return setting === 'review' ? null : setting;
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
  const direct = parseProjectAdminSection(tab);
  // An account section id (`members`, …) means something else in the overlay
  // vocabulary (`members` is the project roster): it keeps resolving there.
  if (direct && !isWorkspaceAccountSection(direct)) return direct;
  if (tab.startsWith('llm-')) return 'models';
  if (tab === 'channels') return 'connectors';
  if (tab === 'reminders') return 'triggers';
  if (tab === 'settings' || tab === 'workspace') return 'general';
  if (tab === 'experimental') return 'feature-flags';
  if (tab === 'snapshots') return 'sandbox';
  return null;
}

/* Rail labels, keyed by section: the `hardcodedUi.i18nComplete` strings the
   Customize bar and the sidebar already show for these libraries. */
export const RESOURCE_LABEL_KEYS: Partial<Record<ProjectAdminResourceKey, string>> = {
  connectors: 'textc3d2e79ebdd0',
  skills: 'text66d0f523a379',
  // "Triggers": kortix.yaml triggers and loops are one page (2026-10-28).
  triggers: 'texte62f2148a64d',
  models: 'textd17d2d78d76e',
  secrets: 'textd8707d411d99',
  apps: 'text89dd748442c1',
  repo: 'text91dba14806eb',
};

/**
 * The one Settings panel of a workspace (design.md §3.2 C7).
 *
 * The registry every surface reads: the web panel and its rail, the CLI and
 * the API when they print a settings link, the emails, and the My Kortix
 * prompt's "where to click" table. A section is renamed or moved here once,
 * and every printed link follows.
 *
 * The panel lives at `/workspaces/<id>/admin/<section>` (Slack's `/admin`).
 * Preferences (the person's own settings) is a separate overlay at
 * `/workspaces/<id>/settings/<tab>` and is not in this registry.
 */

export const WORKSPACE_SETTINGS_GROUPS = [
  { id: 'workspace', sections: ['general', 'security', 'branding', 'api-keys', 'capture'] },
  // What the workspace's agents work with. Git configures the repository
  // connection; Repository browses its files (with Drive on).
  { id: 'library', sections: ['models', 'connectors', 'secrets', 'skills', 'drives', 'apps', 'triggers', 'sandbox', 'git', 'repo'] },
  { id: 'people', sections: ['members', 'groups', 'roles', 'identity', 'audit'] },
  { id: 'billing', sections: ['plan', 'usage'] },
  { id: 'advanced', sections: ['feature-flags'] },
  { id: 'danger', sections: ['danger-zone'] },
  // The rail draws Help in its footer, under the groups.
  { id: 'support', sections: ['help'] },
] as const;

export type WorkspaceSettingsGroup = (typeof WORKSPACE_SETTINGS_GROUPS)[number]['id'];
export type WorkspaceSettingsSection = (typeof WORKSPACE_SETTINGS_GROUPS)[number]['sections'][number];

/** Every section, top to bottom, in panel order. */
export const WORKSPACE_SETTINGS_SECTIONS: readonly WorkspaceSettingsSection[] = WORKSPACE_SETTINGS_GROUPS.flatMap(
  (group) => group.sections as readonly WorkspaceSettingsSection[],
);

/** The section `/workspaces/<id>/admin` opens. */
export const WORKSPACE_SETTINGS_DEFAULT_SECTION: WorkspaceSettingsSection = 'general';

/** Old ids and old account-hub tabs → the section that owns them now. */
export const WORKSPACE_SETTINGS_SECTION_ALIASES: Readonly<Record<string, WorkspaceSettingsSection>> = {
  access: 'members',
  'access-projects': 'members',
  settings: 'security',
  tokens: 'api-keys',
  billing: 'plan',
  credits: 'plan',
  transactions: 'usage',
  connected: 'git',
  loops: 'triggers',
  flags: 'feature-flags',
  experimental: 'feature-flags',
  snapshots: 'sandbox',
  repository: 'repo',
  danger: 'danger-zone',
};

/** English labels (the en catalog uses the same words; a web test holds them equal). */
export const WORKSPACE_SETTINGS_LABELS: Readonly<Record<WorkspaceSettingsSection, string>> = {
  general: 'General',
  security: 'Security',
  branding: 'Branding',
  git: 'Git',
  sandbox: 'Sandbox',
  'feature-flags': 'Feature flags',
  'api-keys': 'API keys',
  capture: 'Capture',
  'danger-zone': 'Danger zone',
  connectors: 'Connectors',
  secrets: 'Secrets',
  skills: 'Skills',
  drives: 'Drives',
  apps: 'Apps',
  triggers: 'Triggers',
  models: 'Models',
  repo: 'Repository',
  members: 'Members',
  groups: 'Groups',
  roles: 'Roles',
  identity: 'Identity',
  audit: 'Audit log',
  plan: 'Plan',
  usage: 'Usage',
  help: 'Help',
};

/** English group labels, in panel order. */
export const WORKSPACE_SETTINGS_GROUP_LABELS: Readonly<Record<WorkspaceSettingsGroup, string>> = {
  workspace: 'Workspace',
  library: 'Library',
  people: 'People',
  billing: 'Billing',
  advanced: 'Advanced',
  danger: 'Danger zone',
  support: 'Support',
};

const SECTION_SET: ReadonlySet<string> = new Set(WORKSPACE_SETTINGS_SECTIONS);

/** True when `value` is a current section id (aliases are not). */
export function isWorkspaceSettingsSection(value: unknown): value is WorkspaceSettingsSection {
  return typeof value === 'string' && SECTION_SET.has(value);
}

/**
 * A section id from a URL segment, a query value or a CLI flag. Resolves the
 * old ids through {@link WORKSPACE_SETTINGS_SECTION_ALIASES}. `null` for an
 * empty or unknown value.
 */
export function parseWorkspaceSettingsSection(raw: string | null | undefined): WorkspaceSettingsSection | null {
  const value = raw?.trim().toLowerCase();
  if (!value) return null;
  if (isWorkspaceSettingsSection(value)) return value;
  return Object.prototype.hasOwnProperty.call(WORKSPACE_SETTINGS_SECTION_ALIASES, value)
    ? WORKSPACE_SETTINGS_SECTION_ALIASES[value]!
    : null;
}

/** The group a section belongs to. */
export function workspaceSettingsGroupOf(section: WorkspaceSettingsSection): WorkspaceSettingsGroup {
  const group = WORKSPACE_SETTINGS_GROUPS.find((g) => (g.sections as readonly string[]).includes(section));
  // Every section is in exactly one group (the type guarantees it).
  return group!.id;
}

/**
 * The app path of a workspace's Settings panel: `/workspaces/<id>/admin/<section>`.
 * Without a section, `/workspaces/<id>/admin` (opens `general`). Prefix the app
 * origin for an absolute link.
 */
export function workspaceSettingsPath(workspaceId: string, section?: WorkspaceSettingsSection): string {
  const base = `/workspaces/${encodeURIComponent(workspaceId)}/admin`;
  return section ? `${base}/${section}` : base;
}

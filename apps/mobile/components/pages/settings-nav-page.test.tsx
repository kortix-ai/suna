import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import React from 'react';
// @ts-ignore -- this app has no @types/react-test-renderer
import { act, create } from 'react-test-renderer';
import { readFileSync } from 'node:fs';

// Project Settings (KRTX-1720): every edit row follows the leaf its route
// asserts, from one `useCans` probe, and nothing is editable while the probe
// is unresolved. The page used to check the 'manager' label, so a custom role
// holding project.write + project.settings.write could not rename the project.
// Real: the page, the SDK leaf catalog, the Customize list. Every other import
// is a stub.

const source = readFileSync(`${import.meta.dir}/SettingsNavPage.tsx`, 'utf8');
const host = (name: string) => ({ children, ...props }: any) => React.createElement(name, props, children);
const Empty = () => null;

type Can = { allowed: boolean; reason: string | null; isLoading: boolean; isError: boolean };
const can = (allowed: boolean, isLoading = false): Can => ({ allowed, reason: null, isLoading, isError: false });
let cans: Record<string, Can> = {};
const probes: Array<{ target: unknown; actions: readonly string[] }> = [];
let rows: Array<{ label?: string; onPress?: () => void }> = [];

const project = {
  project_id: 'proj-1',
  account_id: 'acc-1',
  name: 'Apollo',
  repo_url: 'https://github.com/example-org/apollo',
  default_branch: 'main',
  manifest_path: 'kortix.yaml',
  effective_project_role: 'member',
};

const fakes: Record<string, Record<string, unknown>> = {
  'react-native': { View: host('View') },
  nativewind: { useColorScheme: () => ({ colorScheme: 'light' }) },
  'expo-router': { useRouter: () => ({ replace() {} }) },
  'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) },
  '@tanstack/react-query': {
    useMutation: () => ({ mutate() {}, isPending: false }),
    useQueryClient: () => ({ invalidateQueries() {} }),
  },
  '@kortix/sdk/react': {
    useCans: (target: unknown, actions: readonly string[]) => {
      probes.push({ target, actions });
      return Object.fromEntries(actions.map((action) => [action, cans[action] ?? can(false, true)]));
    },
  },
  '@/components/kortix/page-content': { PageContent: host('PageContent') },
  '@/components/kortix/page-list': { PageList: ({ children }: any) => children },
  '@/components/kortix/settings-list': {
    SettingsGroup: host('Group'),
    SettingsRow: (props: any) => {
      rows.push({ label: props.label, onPress: props.onPress });
      return React.createElement('Row', { label: props.label });
    },
  },
  '@/components/kortix/toast-provider': { useToast: () => ({ error() {}, success() {} }) },
  '@/lib/theme-colors': { useThemeColors: () => ({}) },
  '@/lib/utils/theme': {
    THEME: { light: { background: 'b', foreground: 'f' }, dark: { background: 'b', foreground: 'f' } },
    withAlpha: (color: string) => color,
  },
  '@/lib/projects/hooks': {
    projectKeys: { connectors: () => ['connectors'] },
    useProject: () => ({ data: project, isLoading: false, isError: false, error: null, refetch() {} }),
    useUpdateProject: () => ({ mutateAsync: async () => {} }),
    useArchiveProject: () => ({ mutate() {} }),
  },
  '@/lib/projects/projects-client': { inviteRepoCollaborator: async () => ({}), isManagedGithubProject: () => true },
  '@/lib/projects/web-project-links': {
    CONNECTORS_DONE_URI: 'kortix://connectors/done',
    CONNECTORS_RETURN_URL: 'kortix://connectors',
    projectConnectorsWebUrl: () => 'https://example.test',
    projectCustomizeWebUrl: () => 'https://example.test',
  },
  '@/lib/kortix-web': { KORTIX_WEB_URL: 'https://example.test' },
  '@/components/session/dock-icons': { DOCK_ICONS: {} },
  '@/lib/haptics': { haptics: { tap() {}, success() {}, warning() {}, medium() {}, selection() {} } },
  '@/lib/logger': { log: { error() {} } },
  '@/lib/utils/open-link': { openLink: async () => {} },
};
const real = new Set(['react', '@kortix/sdk', '@/lib/session/dock-menu', '@/lib/session/nav-access', '@/lib/session/project-stack']);
const stubs: Record<string, Record<string, unknown>> = {};
for (const [, names, name] of source.matchAll(/import\s+(?:type\s+)?(?:\w+\s*,\s*)?\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/gs)) {
  if (real.has(name)) continue;
  const values = (stubs[name] ??= { ...fakes[name] });
  for (const item of names.split(',')) {
    const key = item.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0];
    if (key && !(key in values)) values[key] = Empty;
  }
}
stubs['expo-web-browser'] = { openAuthSessionAsync: async () => ({}) };
for (const [name, values] of Object.entries(stubs)) mock.module(name, () => values);

let SettingsNavPage: typeof import('./SettingsNavPage').SettingsNavPage;
beforeAll(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  SettingsNavPage = (await import('./SettingsNavPage')).SettingsNavPage;
});

let tree: any;
function renderAs(next: Record<string, Can>) {
  cans = next;
  rows = [];
  act(() => {
    tree = create(<SettingsNavPage page={{ id: 'page:settings', label: 'Settings' }} projectId="proj-1" onOpenPage={() => {}} />);
  });
}
afterEach(() => {
  act(() => tree?.unmount());
  tree = undefined;
  probes.length = 0;
});

const row = (label: string) => rows.find((r) => r.label === label);
const editable = (label: string) => typeof row(label)?.onPress === 'function';
const EDIT_ROWS = ['Name', 'Default branch', 'Manifest path'];

const MANAGER = {
  'project.write': can(true),
  'project.settings.write': can(true),
  'project.members.manage': can(true),
  'project.delete': can(true),
};

describe('project Settings controls', () => {
  test('one probe: the leaves the edit, collaborator and delete routes assert, with the account passed along', () => {
    renderAs(MANAGER);
    const probe = probes.at(-1)!;
    expect(probe.target).toEqual({ projectId: 'proj-1', accountId: 'acc-1' });
    expect(probe.actions.slice(0, 4)).toEqual(['project.write', 'project.settings.write', 'project.members.manage', 'project.delete']);
    expect(probe.actions).toContain('project.secret.read');
    expect(new Set(probe.actions).size).toBe(probe.actions.length);
  });

  test('a manager edits every field, adds a collaborator and deletes the project', () => {
    renderAs(MANAGER);
    for (const label of EDIT_ROWS) expect(editable(label)).toBe(true);
    expect(row('Add collaborator')).toBeTruthy();
    expect(row('Delete project')).toBeTruthy();
  });

  test('a built-in member reads every field and edits none', () => {
    renderAs({ 'project.write': can(false), 'project.settings.write': can(false) });
    for (const label of EDIT_ROWS) {
      expect(row(label)).toBeTruthy();
      expect(editable(label)).toBe(false);
    }
    expect(row('Add collaborator')).toBeUndefined();
    expect(row('Delete project')).toBeUndefined();
  });

  test('a custom role with project.write + project.settings.write edits the fields, and nothing else', () => {
    renderAs({ 'project.write': can(true), 'project.settings.write': can(true) });
    for (const label of EDIT_ROWS) expect(editable(label)).toBe(true);
    expect(row('Add collaborator')).toBeUndefined();
    expect(row('Delete project')).toBeUndefined();
  });

  test('project.settings.write without project.write edits nothing: PATCH loads the project for write first', () => {
    renderAs({ 'project.settings.write': can(true) });
    for (const label of EDIT_ROWS) expect(editable(label)).toBe(false);
  });

  test('while the probe is unresolved, nothing is editable and nothing destructive shows (fail closed)', () => {
    renderAs({});
    for (const label of EDIT_ROWS) expect(editable(label)).toBe(false);
    expect(row('Add collaborator')).toBeUndefined();
    expect(row('Delete project')).toBeUndefined();
  });
});

describe('Customize group follows the read leaf and a write leaf', () => {
  const CUSTOMIZE = ['Schedules', 'Secrets', 'Members', 'Connectors', 'More on kortix.com'];
  test('a plain member sees no Customize row and no hand-off', () => {
    renderAs({
      'project.trigger.read': can(true),
      'project.secret.read': can(true),
      'project.members.read': can(false),
      'project.connector.read': can(true),
    });
    for (const label of CUSTOMIZE) expect(row(label)).toBeUndefined();
  });
  test('nothing shows while the probe is unresolved', () => {
    renderAs({});
    for (const label of CUSTOMIZE) expect(row(label)).toBeUndefined();
  });
  test('secret read + write shows Secrets only, with the web hand-off', () => {
    renderAs({ 'project.secret.read': can(true), 'project.secret.write': can(true) });
    expect(row('Secrets')).toBeTruthy();
    expect(row('Schedules')).toBeUndefined();
    expect(row('More on kortix.com')).toBeTruthy();
  });
});

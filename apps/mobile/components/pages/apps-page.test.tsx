import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
// @ts-ignore -- this app has no @types/react-test-renderer
import { act, create } from 'react-test-renderer';
import { readFileSync } from 'node:fs';

// AppsPage is the mobile Apps tab: it lists the project's Apps (the same
// inventory web renders) and opens one through an access session handed to
// the Browser page tab. Real: the page, its row mapping and its open flow.
// Every design-system primitive is a prop-recording stub, so the assertions
// read the props the page passes, not a re-implementation of the primitives.

const source = readFileSync(`${import.meta.dir}/AppsPage.tsx`, 'utf8');
const host = (name: string) => ({ children, ...props }: any) => React.createElement(name, props, children);
const Empty = () => null;

// ── Recorded collaborators ──────────────────────────────────────────────────

let listProps: any;
let rowProps: any[] = [];
let dotProps: any[] = [];
let sessionCalls: [string, string][] = [];
let sessionResult: { url: string; expires_at: string } | Error = { url: '', expires_at: '' };
let tabStateCalls: [string, Record<string, unknown>][] = [];
let pageCalls: string[] = [];
let toastErrors: string[] = [];
let taps = 0;

const fakes: Record<string, Record<string, unknown>> = {
  'react-native': { View: host('View') },
  '@/components/kortix/page-content': { PageContent: host('PageContent') },
  '@/components/kortix/page-header': { PageHeader: host('PageHeader') },
  '@/components/kortix/page-list': {
    // Renders the rows through the page's renderItem, and records the state
    // props so a test can read what the page asked the list to show.
    PageList: (props: any) => {
      listProps = props;
      return React.createElement(
        'List',
        null,
        (props.data ?? []).map((item: any, index: number) =>
          React.createElement(React.Fragment, { key: props.keyExtractor(item, index) }, props.renderItem(item, index))
        )
      );
    },
    StatusDot: (props: any) => {
      dotProps.push(props);
      return null;
    },
  },
  '@/components/kortix/settings-list': {
    SettingsGroupItem: host('Group'),
    SettingsRow: (props: any) => {
      rowProps.push(props);
      // The trailing content renders, so the StatusDot stub records its props.
      return React.createElement('Row', null, props.right);
    },
  },
  '@/components/kortix/kortix-loader': { KortixLoader: Empty },
  '@/components/kortix/toast-provider': {
    useToast: () => ({ error: (message: string) => toastErrors.push(message) }),
  },
  '@/components/ui/icon': { Icon: Empty },
  '@/lib/icons': { CaretRightIcon: Empty },
  '@/lib/haptics': { haptics: { tap: () => { taps++; } } },
  '@/lib/projects/hooks': {
    useProject: () => projectQuery,
    useProjectApps: () => appsQuery,
  },
  '@/lib/projects/projects-client': {
    createAppAccessSession: async (projectId: string, appId: string) => {
      sessionCalls.push([projectId, appId]);
      if (sessionResult instanceof Error) throw sessionResult;
      return sessionResult;
    },
  },
  '@/stores/tab-store': {
    useTabStore: Object.assign((selector: any) => selector(tabState), {
      getState: () => tabState,
    }),
  },
};

const tabState = {
  setTabState: (tabId: string, patch: Record<string, unknown>) => tabStateCalls.push([tabId, patch]),
  navigateToPage: (pageId: string) => pageCalls.push(pageId),
};

let projectQuery: any;
let appsQuery: any;

const real = new Set(['react']);
const named = new Map<string, Set<string>>();
for (const [, names, name] of source.matchAll(/import\s+(?:\w+\s*,\s*)?\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/gs)) {
  const set = named.get(name) ?? new Set<string>();
  for (const item of names.split(',')) {
    const key = item.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0];
    if (key) set.add(key);
  }
  named.set(name, set);
}
for (const [name, keys] of named) {
  if (real.has(name)) continue;
  const values: Record<string, unknown> = { ...fakes[name] };
  for (const key of keys) if (!(key in values)) values[key] = Empty;
  mock.module(name, () => values);
}

let AppsPage: typeof import('./AppsPage').AppsPage;
beforeAll(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  AppsPage = (await import('./AppsPage')).AppsPage;
});

const app = (over: Record<string, unknown> = {}) => ({
  app_id: 'a-1',
  slug: 'report-writer',
  name: 'Report writer',
  url: 'https://report-writer.apps.example.test',
  desired_state: 'running',
  viewer_can_access: true,
  ...over,
});
const props = (projectId = 'proj-1') => ({ page: { id: 'page:apps', label: 'Apps' }, projectId });
const flagOn = { isLoading: false, data: { experimental: { apps: true } } };

beforeEach(() => {
  rowProps = [];
  dotProps = [];
  sessionCalls = [];
  tabStateCalls = [];
  pageCalls = [];
  toastErrors = [];
  taps = 0;
  sessionResult = { url: 'https://report-writer.apps.example.test/?__kortix_access=t', expires_at: '' };
  projectQuery = flagOn;
  appsQuery = { isLoading: false, isError: false, error: null, data: [app()], refetch: async () => {} };
  listProps = null;
});

async function render() {
  let tree: any;
  await act(async () => {
    tree = create(React.createElement(AppsPage, props()));
  });
  return tree;
}

describe('AppsPage', () => {
  test('lists the project Apps with name, slug and running state', async () => {
    appsQuery = { ...appsQuery, data: [app(), app({ app_id: 'a-2', slug: 'dash', name: 'Dashboard', desired_state: 'stopped' })] };
    const tree = await render();
    expect(rowProps.map((row) => row.label)).toEqual(['Report writer', 'Dashboard']);
    expect(rowProps[0].description).toBe('report-writer');
    expect(rowProps[1].description).toBe('dash');
    expect(dotProps.map((dot) => dot.on)).toEqual([true, false]);
    expect(rowProps[0].onPress).toBeTypeOf('function');
    // The list itself is not loading and not empty.
    expect(listProps.isLoading).toBe(false);
    expect(listProps.emptyLabel).toBeNull();
    await act(async () => tree.unmount());
  });

  test('an open mints an access session and opens it in the Browser page tab', async () => {
    const tree = await render();
    await act(async () => {
      await rowProps[0].onPress();
    });
    expect(sessionCalls).toEqual([['proj-1', 'a-1']]);
    expect(tabStateCalls).toEqual([
      ['page:browser', { savedUrl: 'https://report-writer.apps.example.test/?__kortix_access=t', savedDisplay: 'Report writer' }],
    ]);
    expect(pageCalls).toEqual(['page:browser']);
    expect(toastErrors).toEqual([]);
    await act(async () => tree.unmount());
  });

  test('a failed open reports the error and stays on the page', async () => {
    sessionResult = new Error('App access denied');
    const tree = await render();
    await act(async () => {
      await rowProps[0].onPress();
    });
    expect(sessionCalls).toHaveLength(1);
    expect(tabStateCalls).toEqual([]);
    expect(pageCalls).toEqual([]);
    expect(toastErrors).toEqual(['App access denied']);
    await act(async () => tree.unmount());
  });

  test('an App the viewer cannot open shows no access and never mints a session', async () => {
    appsQuery = { ...appsQuery, data: [app({ viewer_can_access: false })] };
    const tree = await render();
    expect(rowProps[0].description).toBe('report-writer · No access');
    expect(rowProps[0].onPress).toBeUndefined();
    await act(async () => tree.unmount());
    expect(sessionCalls).toEqual([]);
  });

  test('the page is gated by the apps feature flag, fail-closed', async () => {
    projectQuery = { isLoading: false, data: { experimental: { apps: false } } };
    const tree = await render();
    expect(listProps.emptyLabel).toBe('Apps is not enabled for this project');

    // Loading counts as disabled: the list stays loading, no rows show.
    projectQuery = { isLoading: true, data: undefined };
    await act(async () => {
      tree.update(React.createElement(AppsPage, props()));
    });
    expect(listProps.isLoading).toBe(true);
    expect(listProps.emptyLabel).toBe('Apps is not enabled for this project');
    await act(async () => tree.unmount());
  });

  test('an empty project shows the empty state, a failed list shows the error', async () => {
    appsQuery = { ...appsQuery, data: [] };
    let tree = await render();
    expect(listProps.emptyLabel).toBe('No Apps in this project yet');
    await act(async () => tree.unmount());

    appsQuery = { ...appsQuery, isError: true, error: new Error('Forbidden'), data: [] };
    tree = await render();
    expect(listProps.errorMessage).toBe('Forbidden');
    await act(async () => tree.unmount());
  });
});

import { beforeEach, expect, mock, test } from 'bun:test';
import { createElement, type FC } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import type { App, ProjectGoal, ProjectSpace } from '@kortix/sdk';

// The space page is a channel: the room tab first, then the configured tabs
// (or the defaults), with `?tab=` picking one. Hooks are mocked by resolved module.

let spaces: ProjectSpace[] = [];
let tabParam: string | null = null;
let flags: Record<string, boolean> = {};
const agents = [
  { name: 'closer', space: 'sales' },
  { name: 'builder', space: 'engineering' },
];

const app = (slug: string, display: App['display']): App =>
  ({ app_id: `app_${slug}`, slug, name: slug.toUpperCase(), display, active_deployment_id: null }) as unknown as App;
const goal = (slug: string, binding: { space?: string | null; agent?: string | null }): ProjectGoal =>
  ({
    slug,
    scope: 'company',
    goal: { objective: `Objective ${slug}`, status: 'active', ...binding },
    health: { state: 'healthy', issues: [] },
  }) as unknown as ProjectGoal;

const sdkReact = await import('@kortix/sdk/react');
mock.module('@kortix/sdk/react', () => ({
  ...sdkReact,
  useProjectConfig: () => ({ agents, spaces }),
  useFeatureFlag: (_id: string, key: string) => ({ enabled: flags[key] ?? true, isLoading: false }),
  useProjectApps: () => ({ data: [app('crm', { space: 'sales' }), app('ci', { agent: 'builder' })], isLoading: false }),
  useProjectGoals: () => ({ data: [goal('q4', { agent: 'closer' }), goal('ship', { space: 'engineering' })], isLoading: false }),
  useArtifacts: () => ({ data: [], isLoading: false }),
  useSpaceRoom: () => ({ data: null }),
  useRoom: () => ({ data: undefined }),
  useSessionsNeedingInput: () => ({ data: { total: 0, sessions: {} } }),
  useProjectSessions: () => ({ sessions: [] }),
}));
const can = await import('../../internal/lib/use-project-can');
mock.module('../../internal/lib/use-project-can', () => ({ ...can, useProjectCan: () => ({ allowed: true }) }));
mock.module('../../customize/use-configure-thread', () => ({ useConfigureThread: () => ({ start: () => {}, pending: false }) }));
const provider = await import('../../providers/ui-provider');
mock.module('../../providers/ui-provider', () => ({
  ...provider,
  useUiSearchParams: () => new URLSearchParams(tabParam ? { tab: tabParam } : {}),
  useUiRouter: () => ({ push: () => {}, replace: () => {} }),
  useUiPathname: () => '/projects/p1/spaces/sales',
}));

const { SpacePage, visibleSpaceTabs } = await import('./space-page');
const Host = provider.UiProvider as unknown as FC<{ components: Parameters<typeof provider.UiProvider>[0]['components'] }>;
const RoomPanel = (props: { roomName: string; fill?: boolean }) =>
  createElement('div', { 'data-testid': 'room-panel', 'data-room': props.roomName, 'data-fill': String(!!props.fill) });

function render(slug = 'sales') {
  const page = createElement(Host, { components: { RoomPanel } }, createElement(SpacePage, { projectId: 'p1', slug }));
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, page));
}

beforeEach(() => {
  spaces = [{ name: 'sales', label: 'Sales', description: 'Pipeline and deals' }];
  tabParam = null;
  flags = {};
});

test('the header names the space once, and the room is the first tab, filling the page', () => {
  const html = render();
  expect(html.match(/<h1[^>]*>.*?<\/h1>/)?.[0]).toContain('>Sales<');
  expect(html.split('>Sales<').length - 1).toBe(1);
  expect(html).toContain('Pipeline and deals');
  expect(html).toContain('data-room="sales"');
  expect(html).toContain('data-fill="true"');
  expect(html.indexOf('>Room<')).toBeLessThan(html.indexOf('>Goals<'));
});

test('a space with no tabs shows the default views; configured tabs replace them', () => {
  expect(render()).toContain('>Artifacts<');
  spaces = [{ name: 'sales', label: 'Sales', tabs: [{ type: 'link', label: 'Status', url: 'https://status.example.com' }] }];
  const html = render();
  expect(html).toContain('>Status<');
  expect(html).not.toContain('>Goals<');
});

test('?tab= opens a tab, and Goals lists what is bound to the space through its agent', () => {
  tabParam = 'goals';
  const html = render();
  expect(html).toContain('Objective q4');
  expect(html).not.toContain('Objective ship');
  expect(html).not.toContain('data-testid="room-panel"');
});

test('an unknown ?tab= falls back to the room', () => {
  tabParam = 'board-9';
  expect(render()).toContain('data-testid="room-panel"');
});

test('a tab of a feature that is off is hidden', () => {
  const space: ProjectSpace = { name: 'sales', tabs: [{ type: 'goals' }, { type: 'apps' }, { type: 'artifact', artifact: 'a1' }] };
  expect(visibleSpaceTabs(space, { goals: false, artifacts: false }).map((entry) => entry.key)).toEqual(['apps']);
  expect(visibleSpaceTabs(space, { goals: true, artifacts: true }).map((entry) => entry.key)).toEqual([
    'goals',
    'apps',
    'artifact-a1',
  ]);
});

test('the header shows only the configured items', () => {
  spaces = [{ name: 'sales', label: 'Sales', header: ['agents'] }];
  const html = render();
  expect(html).toContain('aria-label="Agents in this space"');
  expect(html).not.toContain('New session');
  expect(html).not.toContain('Ask My Kortix');
  spaces = [{ name: 'sales', label: 'Sales' }];
  expect(render()).toContain('New session');
});

test('a space that is not in the config says so', () => {
  expect(render('gone')).toContain('This space is gone');
});

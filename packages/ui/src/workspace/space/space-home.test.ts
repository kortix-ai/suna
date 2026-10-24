import { beforeEach, expect, mock, test } from 'bun:test';
import { createElement, type FC } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { App, Artifact, ProjectGoal } from '@kortix/sdk';

// The space home lists what is bound to the space: an App by `display.space`
// (or its agent's space), a Goal by `goal.json` `space`/`agent`, an Artifact
// from the server's space filter. Hooks are mocked by resolved module.

const config = {
  agents: [
    { name: 'closer', domain: 'sales' },
    { name: 'builder', domain: 'engineering' },
  ],
  domains: [{ name: 'sales', label: 'Sales', description: 'Pipeline and deals' }],
};
let artifactFilter: unknown = null;
let artifactRows: Partial<Artifact>[] = [];

const app = (slug: string, display: App['display']): App =>
  ({ app_id: `app_${slug}`, slug, name: slug.toUpperCase(), display, active_deployment_id: null }) as unknown as App;
const goal = (slug: string, binding: { space?: string | null; agent?: string | null }): ProjectGoal =>
  ({
    slug,
    scope: 'company',
    driveId: 'd1',
    folder: `/Company/Goals/${slug}`,
    goal: { objective: `Objective ${slug}`, status: 'active', ...binding },
    heartbeat: null,
    coordinatorSessionId: null,
    health: { state: 'healthy', issues: [] },
  }) as unknown as ProjectGoal;

const sdkReact = await import('@kortix/sdk/react');
mock.module('@kortix/sdk/react', () => ({
  ...sdkReact,
  useProjectConfig: () => config,
  useFeatureFlag: () => ({ enabled: true, isLoading: false }),
  useProjectApps: () => ({
    data: [app('crm', { space: 'sales' }), app('forecast', { agent: 'closer' }), app('ci', { agent: 'builder' }), app('wiki', {})],
    isLoading: false,
  }),
  useProjectGoals: () => ({
    data: [goal('q4-pipeline', { agent: 'closer' }), goal('ship-v2', { space: 'engineering', agent: 'closer' }), goal('old', {})],
    isLoading: false,
  }),
  useArtifacts: (_projectId: string | null, filter: unknown) => {
    artifactFilter = filter;
    return { data: artifactRows, isLoading: false };
  },
}));

const { SpaceHome } = await import('./space-home');
const { UiProvider } = await import('../../providers/ui-provider');
// createElement takes children as its third argument; the provider's props type requires them.
const Host = UiProvider as unknown as FC<{ components: Parameters<typeof UiProvider>[0]['components'] }>;

const RoomPanel = (props: { roomName: string; emptyTopic?: string }) =>
  createElement('div', { 'data-testid': 'room-panel', 'data-room': props.roomName, 'data-topic': props.emptyTopic });

function render(space = config.domains[0]!) {
  return renderToStaticMarkup(
    createElement(Host, { components: { RoomPanel } }, createElement(SpaceHome, { projectId: 'p1', space })),
  );
}

beforeEach(() => {
  artifactFilter = null;
  artifactRows = [{ artifact_id: 'a1', title: 'Deal memo', type: 'doc' }];
});

test('the space room is the room named like the slug, and gets the description as its first topic', () => {
  const html = render();
  expect(html).toContain('data-room="sales"');
  expect(html).toContain('data-topic="Pipeline and deals"');
});

test('lists Apps and Goals bound to the space, directly or through their agent, and nothing else', () => {
  const html = render();
  expect(html).toContain('CRM');
  expect(html).toContain('FORECAST');
  expect(html).not.toContain('>CI<');
  expect(html).not.toContain('WIKI');
  expect(html).toContain('Objective q4-pipeline');
  // An explicit space wins over the agent's space.
  expect(html).not.toContain('Objective ship-v2');
  expect(html).not.toContain('Objective old');
});

test('asks the server for the space and its agents, and links "View all" to the filtered page', () => {
  const html = render();
  expect(artifactFilter).toMatchObject({ space: 'sales', agents: ['closer'] });
  expect(html).toContain('Deal memo');
  expect(html).toContain('href="/projects/p1/artifacts/a1"');
  expect(html).toContain('href="/projects/p1/goals?space=sales"');
  expect(html).toContain('href="/projects/p1/artifacts?space=sales"');
});

test('an empty list is hidden, and the rail is gone when nothing is bound', () => {
  artifactRows = [];
  expect(render()).not.toContain('Artifacts');
  const html = render({ name: 'ops' } as never);
  expect(html).not.toContain('In this space');
  expect(html).toContain('data-room="ops"');
});

test('a chat block for the space room is not drawn twice; one for another room is', () => {
  const html = render({
    ...config.domains[0]!,
    blocks: [
      { type: 'chat', label: 'Chat', room: 'sales' },
      { type: 'chat', label: 'Standup', room: 'standup' },
    ],
  } as never);
  expect(html.match(/data-room="sales"/g)?.length).toBe(1);
  expect(html).toContain('data-room="standup"');
});

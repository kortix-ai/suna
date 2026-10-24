import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { App, SpaceBlock } from '@kortix/sdk';

// Each block type renders its own element; a block whose data is missing — or
// whose `app` slug resolves to nothing — degrades to a muted line, never a
// crash. The heavy embeds are mocked per the design-system skill (mock.module
// by resolved file): AppPreview (frame pool + signed URL) and UnifiedMarkdown.
// The `chat` block is an intentional placeholder, so it has no heavy dep.

// Controllable App inventory + access-session results the component reads.
let appsResult: { data?: App[]; isLoading: boolean } = { data: [], isLoading: false };
let accessResult: { session: { data?: { url: string }; isError: boolean } } = {
  session: { data: undefined, isError: false },
};

const sdkReact = await import('@kortix/sdk/react');
mock.module('@kortix/sdk/react', () => ({
  ...sdkReact,
  useProjectApps: () => appsResult,
  useAppAccess: () => accessResult,
}));

mock.module('../../apps/app-preview', () => ({
  AppPreview: (props: { app: App; url: string | null }) =>
    createElement('div', { 'data-testid': 'app-preview', 'data-slug': props.app.slug }),
}));

const markdown = await import('../../markdown');
mock.module('../../markdown', () => ({
  ...markdown,
  UnifiedMarkdown: (props: { content: string }) =>
    createElement('div', { 'data-testid': 'markdown' }, props.content),
}));

const { SpaceBlocks } = await import('./space-blocks');

function render(blocks: SpaceBlock[]): string {
  return renderToStaticMarkup(createElement(SpaceBlocks, { projectId: 'p1', blocks }));
}

/** A live, openable App for the `app` block to resolve to. */
function liveApp(slug: string): App {
  return {
    app_id: `app_${slug}`,
    slug,
    active_deployment_id: 'dep_1',
    capabilities: ['preview'],
    viewer_can_access: true,
  } as unknown as App;
}

test('no blocks renders nothing', () => {
  expect(render([])).toBe('');
});

test('text block renders its markdown', () => {
  const html = render([{ type: 'text', label: 'Note', text: '# Hi' }]);
  expect(html).toContain('data-testid="markdown"');
  expect(html).toContain('# Hi');
});

test('text block with no content degrades to a notice', () => {
  const html = render([{ type: 'text', label: 'Note' }]);
  expect(html).not.toContain('data-testid="markdown"');
  expect(html).toContain('No content yet.');
});

test('iframe block renders a sandboxed frame for its url', () => {
  const html = render([{ type: 'iframe', label: 'Embed', url: 'https://example.com' }]);
  expect(html).toContain('<iframe');
  expect(html).toContain('src="https://example.com"');
  expect(html).toContain('sandbox=');
});

test('iframe block with no url degrades to a notice', () => {
  const html = render([{ type: 'iframe', label: 'Embed' }]);
  expect(html).not.toContain('<iframe');
  expect(html).toContain('No URL yet.');
});

test('artifact block renders a button to its path', () => {
  const html = render([{ type: 'artifact', label: 'Doc', path: 'docs/README.md' }]);
  expect(html).toContain('<button');
  expect(html).toContain('docs/README.md');
});

test('artifact block with no path degrades to a notice', () => {
  const html = render([{ type: 'artifact', label: 'Doc' }]);
  expect(html).not.toContain('<button');
  expect(html).toContain('No file yet.');
});

test('app block renders the live AppPreview for a resolved slug', () => {
  appsResult = { data: [liveApp('dashboard')], isLoading: false };
  accessResult = { session: { data: { url: 'https://signed.example/app' }, isError: false } };
  const html = render([{ type: 'app', label: 'App', app: 'dashboard' }]);
  expect(html).toContain('data-testid="app-preview"');
  expect(html).toContain('data-slug="dashboard"');
});

test('app block degrades to a notice when the slug resolves to no App', () => {
  appsResult = { data: [liveApp('other')], isLoading: false };
  const html = render([{ type: 'app', label: 'App', app: 'missing' }]);
  expect(html).not.toContain('data-testid="app-preview"');
  expect(html).toContain('is not in this project');
});

test('app block shows a loading line while the inventory loads', () => {
  appsResult = { data: undefined, isLoading: true };
  const html = render([{ type: 'app', label: 'App', app: 'dashboard' }]);
  expect(html).toContain('Loading app');
});

test('app block with no slug degrades to a notice', () => {
  appsResult = { data: [], isLoading: false };
  const html = render([{ type: 'app', label: 'App' }]);
  expect(html).toContain('No app selected yet.');
});

test('chat block renders the labelled placeholder with its room', () => {
  const html = render([{ type: 'chat', label: 'Chat', room: 'sales' }]);
  expect(html).toContain('#sales');
  expect(html).toContain('A shared chat for this space.');
});

test('chat block with no room still renders an intentional placeholder', () => {
  const html = render([{ type: 'chat', label: 'Chat' }]);
  expect(html).not.toContain('#');
  expect(html).toContain('A shared chat for this space.');
});

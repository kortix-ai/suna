import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';

import { testRender } from '@opentui/react/test-utils';

import { initKortix, resetKortixForTest } from './kortix.ts';
import { SCREEN_TITLE, Screen, type ScreenRoute, isScreenRoute } from './screens.tsx';

// React 19 needs this before `act`; without it a key press is asserted against
// the frame React had not yet committed.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SIZE = { width: 100, height: 24 };

/**
 * Some screens read through the one `kortix()` client. It points at a dead
 * port with retries off, so every read fails fast and nothing is mocked.
 */
beforeAll(() => {
  resetKortixForTest();
  initKortix({
    name: 'test',
    backendUrl: 'http://127.0.0.1:9/v1',
    token: 'test-token',
    accountId: '',
    userEmail: '',
    source: 'env',
  });
});

afterAll(() => {
  resetKortixForTest();
});

interface Opened {
  route: ScreenRoute;
  target: string | null;
}

async function mount(
  route: ScreenRoute,
  over: { projectId?: string | null; target?: string | null; opened?: Opened[] } = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rendered = await testRender(
    <QueryClientProvider client={client}>
      <Screen
        route={route}
        projectId={over.projectId ?? null}
        accountId={null}
        sessionId={null}
        focused
        width={SIZE.width}
        height={SIZE.height}
        webBaseUrl="http://127.0.0.1:9"
        target={over.target}
        onBack={() => {}}
        onOpenSession={() => {}}
        onToast={() => {}}
        onHoldsBack={() => {}}
        onOpenScreen={(opened, target) => over.opened?.push({ route: opened, target })}
      />
    </QueryClientProvider>,
    SIZE,
  );
  await act(async () => {
    await rendered.flush();
  });
  const lines = () =>
    rendered
      .captureCharFrame()
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  const destroy = () => {
    act(() => {
      rendered.renderer.destroy();
    });
    client.clear();
  };
  return { ...rendered, lines, destroy };
}

describe('<Screen/> mounts every route', () => {
  test('there are 18 screens, each with a title', () => {
    const routes = Object.keys(SCREEN_TITLE);
    expect(routes).toHaveLength(18);
    for (const route of routes) {
      if (!isScreenRoute(route)) throw new Error(`not a screen route: ${route}`);
      expect(SCREEN_TITLE[route].trim().length).toBeGreaterThan(0);
    }
  });

  // With no project, account or session, every screen still mounts and says
  // what is missing. The wording is the screen's own.
  for (const route of Object.keys(SCREEN_TITLE)) {
    test(`${route}: mounts with no project, account or session and renders what is missing`, async () => {
      if (!isScreenRoute(route)) throw new Error(`not a screen route: ${route}`);
      const screen = await mount(route);
      expect(screen.lines().length).toBeGreaterThan(0);
      screen.destroy();
    });
  }
});

describe('<Screen/> passes what each route needs', () => {
  test('connect: `target` is the query it looks for', async () => {
    const screen = await mount('connect', { projectId: 'p1', target: 'github' });
    expect(screen.lines()[0]).toContain('finding “github”');
    screen.destroy();
  });

  test('connect: a choice opens the screen through `onOpenScreen`', async () => {
    const opened: Opened[] = [];
    const screen = await mount('connect', { opened });
    act(() => {
      screen.mockInput.pressKey('2');
    });
    act(() => {
      screen.mockInput.pressKey('1');
    });
    expect(opened).toEqual([
      { route: 'connectors', target: null },
      { route: 'providers', target: null },
    ]);
    screen.destroy();
  });

  test('connectors, providers, customize, apps, review: a project mounts the screen body', async () => {
    const first: Array<[ScreenRoute, string | undefined]> = [];
    for (const route of ['connectors', 'providers', 'customize', 'apps', 'review'] as const) {
      const screen = await mount(route, { projectId: 'p1' });
      first.push([route, screen.lines().find((line) => line.includes('loading'))]);
      screen.destroy();
    }
    expect(first).toEqual([
      ['connectors', '⠋ loading connectors'],
      ['providers', '⠋ loading providers'],
      ['customize', '⠋ loading agents'],
      ['apps', '⠋ loading Apps'],
      ['review', '⠋ loading change requests'],
    ]);
  });
});

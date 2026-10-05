import { describe, expect, test } from 'bun:test';
import { act } from 'react';

import { testRender } from '@opentui/react/test-utils';

import { openUrl } from '../../lib/open-url.ts';
import {
  ACCESS_PHRASE,
  FIRST_DEPLOY_COMMAND,
  appStatus,
  durationText,
  toRow,
} from './apps-screen.tsx';
import { type AppRow, AppsView, type AppsViewProps, appRowText } from './apps-view.tsx';

// React 19 needs this before `act`; without it a key press is asserted against
// the frame React had not yet committed. See docs/opentui-notes.md.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date(2026, 8, 17, 12, 0, 0).getTime();
const MINUTE = 60_000;
const HOUR = 3_600_000;
const SIZE = { width: 84, height: 24 };

function rows(): AppRow[] {
  return [
    {
      id: 'app-1',
      name: 'Deal desk',
      url: 'https://deal-desk.kortix.app',
      status: { glyph: '●', word: 'Running', tone: 'ok' },
      visibility: 'project',
      updatedMs: NOW - 2 * MINUTE,
    },
    {
      id: 'app-2',
      name: 'Claims viewer',
      url: 'https://claims.kortix.app',
      status: { glyph: '○', word: 'Suspended', tone: 'idle' },
      visibility: 'private',
      updatedMs: NOW - 3 * HOUR,
    },
    {
      id: 'app-3',
      name: 'Never shipped',
      url: '',
      status: { glyph: '○', word: 'Not deployed', tone: 'idle' },
      visibility: 'private',
      updatedMs: NOW - 26 * HOUR,
    },
  ];
}

function props(overrides: Partial<AppsViewProps> = {}): AppsViewProps {
  return {
    rows: rows(),
    focused: true,
    width: 82,
    height: 20,
    now: NOW,
    loading: false,
    errorMessage: null,
    detail: null,
    visibilityOptions: ['private', 'project', 'public'],
    accessPhrase: ACCESS_PHRASE,
    emptyHint: FIRST_DEPLOY_COMMAND,
    onOpenDetails: () => {},
    onOpenUrl: () => {},
    onCopyUrl: () => {},
    onRefresh: () => {},
    onSetState: () => {},
    onSetVisibility: () => {},
    onBack: () => {},
    ...overrides,
  };
}

/**
 * Press Esc and let the key parser resolve it. A lone `ESC` byte is the prefix
 * of every escape sequence, so OpenTUI holds it until a timeout proves nothing
 * follows (docs/opentui-notes.md).
 */
async function pressEscape(mockInput: { pressEscape: () => void }): Promise<void> {
  await act(async () => {
    mockInput.pressEscape();
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
}

describe('appRowText', () => {
  test('prints the glyph, the name, the URL and the status + age', () => {
    const text = appRowText(rows()[0] as AppRow, NOW, 82);
    expect(text).toContain('● Deal desk');
    expect(text).toContain('https://deal-desk.kortix.app');
    expect(text.trimEnd().endsWith('Running · 2m')).toBe(true);
    expect(text.length).toBeLessThanOrEqual(81);
  });

  test('an App with no URL says so instead of leaving the column blank', () => {
    expect(appRowText(rows()[2] as AppRow, NOW, 82)).toContain('not deployed');
  });

  test('a long name is truncated instead of pushing the URL out', () => {
    const wide: AppRow = { ...(rows()[0] as AppRow), name: 'A'.repeat(60) };
    const text = appRowText(wide, NOW, 82);
    expect(text).toContain('…');
    expect(text).toContain('https://deal-desk.kortix.app');
    expect(text.length).toBeLessThanOrEqual(81);
  });
});

describe('appStatus / durationText', () => {
  const base = {
    app_id: 'a',
    account_id: 'acc',
    project_id: 'p',
    slug: 'a',
    name: 'A',
    url: 'https://a.kortix.app',
    access_revision: 1,
    machine: { cpu: 2, memory_gb: 4, disk_gb: 10 },
    idle_timeout_seconds: 600,
    monthly_budget_usd: 5,
    last_request_at: null,
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
  };

  test('a never-deployed App reads "Not deployed" although desired_state is running', () => {
    const status = appStatus({
      ...base,
      access_mode: 'private',
      desired_state: 'running',
      active_deployment_id: null,
    } as Parameters<typeof appStatus>[0]);
    expect(status.word).toBe('Not deployed');
  });

  test('a deployed App follows desired_state', () => {
    const running = appStatus({
      ...base,
      access_mode: 'project',
      desired_state: 'running',
      active_deployment_id: 'dep-1',
    } as Parameters<typeof appStatus>[0]);
    const stopped = appStatus({
      ...base,
      access_mode: 'project',
      desired_state: 'stopped',
      active_deployment_id: 'dep-1',
    } as Parameters<typeof appStatus>[0]);
    expect([running.word, stopped.word]).toEqual(['Running', 'Suspended']);
  });

  test('toRow carries the id, the URL, the access mode and the update stamp', () => {
    const row = toRow({
      ...base,
      access_mode: 'public',
      desired_state: 'running',
      active_deployment_id: 'dep-1',
      updated_at: '2026-09-17T10:00:00.000Z',
    } as Parameters<typeof toRow>[0]);
    expect(row).toMatchObject({ id: 'a', url: 'https://a.kortix.app', visibility: 'public' });
    expect(row.updatedMs).toBe(Date.parse('2026-09-17T10:00:00.000Z'));
  });

  test('durationText prints the shortest exact unit', () => {
    expect([durationText(600), durationText(3600), durationText(45), durationText(0)]).toEqual([
      '10m',
      '1h',
      '45s',
      'never',
    ]);
  });
});

describe('<AppsView/> through the OpenTUI test renderer', () => {
  test('renders one row per App with its status and age', async () => {
    const { captureCharFrame, flush, renderer } = await testRender(<AppsView {...props()} />, SIZE);
    await flush();
    const lines = captureCharFrame()
      .split('\n')
      .map((line) => line.trimEnd());
    expect(lines[0]).toContain('Deal desk');
    expect(lines[0]).toContain('Running · 2m');
    expect(lines[1]).toContain('Claims viewer');
    expect(lines[1]).toContain('Suspended · 3h');
    expect(lines[2]).toContain('Not deployed');
    renderer.destroy();
  });

  test('j and k move the cursor', async () => {
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <AppsView {...props()} />,
      SIZE,
    );
    await flush();
    const marked = () =>
      captureCharFrame()
        .split('\n')
        .find((line) => line.startsWith('▌'))
        ?.trim();
    expect(marked()).toContain('Deal desk');

    await act(async () => mockInput.pressKey('j'));
    await flush();
    expect(marked()).toContain('Claims viewer');

    await act(async () => mockInput.pressKey('G'));
    await flush();
    expect(marked()).toContain('Never shipped');

    await act(async () => mockInput.pressKey('g'));
    await flush();
    expect(marked()).toContain('Deal desk');
    renderer.destroy();
  });

  test('Enter opens the details pane and asks the host for that App', async () => {
    const asked: Array<string | null> = [];
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <AppsView
        {...props({
          onOpenDetails: (id) => asked.push(id),
          detail: {
            loading: false,
            version: 3,
            deployStatus: 'ready',
            deployedAtMs: NOW - 4 * HOUR,
            provider: 'platinum',
            sourceKind: 'bundle',
            error: null,
            machine: '2 vCPU · 4 GB RAM · 10 GB disk',
            idleTimeout: '10m',
            appId: 'app-1',
          },
        })}
      />,
      SIZE,
    );
    await flush();
    await act(async () => mockInput.pressEnter());
    await flush();
    expect(asked).toEqual(['app-1']);

    const frame = captureCharFrame();
    expect(frame).toContain('https://deal-desk.kortix.app');
    expect(frame).toContain('project — Whole team');
    expect(frame).toContain('v3 · ready');
    expect(frame).toContain('4h ago');
    expect(frame).toContain('platinum');
    expect(frame).toContain('2 vCPU · 4 GB RAM · 10 GB disk');

    // Esc leaves the pane and tells the host to stop fetching the detail.
    await pressEscape(mockInput);
    await flush();
    expect(asked).toEqual(['app-1', null]);
    expect(captureCharFrame()).toContain('Claims viewer');
    renderer.destroy();
  });

  test('o hands the selected row to the opener, and the opener spawns the URL', async () => {
    const opened: AppRow[] = [];
    const spawned: string[][] = [];
    const { flush, mockInput, renderer } = await testRender(
      <AppsView {...props({ onOpenUrl: (row) => opened.push(row) })} />,
      SIZE,
    );
    await flush();
    await act(async () => mockInput.pressKey('j'));
    await flush();
    await act(async () => mockInput.pressKey('o'));
    await flush();
    expect(opened.map((row) => row.url)).toEqual(['https://claims.kortix.app']);

    // The screen's own step: that URL reaches the platform opener verbatim.
    await openUrl(opened[0]?.url as string, {
      platform: 'darwin',
      spawn: (argv) => {
        spawned.push(argv);
      },
    });
    expect(spawned).toEqual([['open', 'https://claims.kortix.app/']]);
    renderer.destroy();
  });

  test('y hands the selected row to the copier and r refreshes', async () => {
    const copied: string[] = [];
    let refreshed = 0;
    const { flush, mockInput, renderer } = await testRender(
      <AppsView
        {...props({
          onCopyUrl: (row) => copied.push(row.url),
          onRefresh: () => {
            refreshed += 1;
          },
        })}
      />,
      SIZE,
    );
    await flush();
    await act(async () => mockInput.pressKey('y'));
    await flush();
    expect(copied).toEqual(['https://deal-desk.kortix.app']);

    await act(async () => mockInput.pressKey('r'));
    await flush();
    expect(refreshed).toBe(1);
    renderer.destroy();
  });

  test('d asks before suspending: y confirms with the opposite state, Esc cancels', async () => {
    const changes: Array<[string, string]> = [];
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <AppsView {...props({ onSetState: (row, next) => changes.push([row.id, next]) })} />,
      SIZE,
    );
    await flush();
    await act(async () => mockInput.pressKey('d'));
    await flush();
    expect(captureCharFrame()).toContain('Suspend App');

    await pressEscape(mockInput);
    await flush();
    expect(changes).toEqual([]);

    await act(async () => mockInput.pressKey('d'));
    await flush();
    await act(async () => mockInput.pressKey('y'));
    await flush();
    expect(changes).toEqual([['app-1', 'stopped']]);

    // A suspended App offers the opposite action.
    await act(async () => mockInput.pressKey('j'));
    await flush();
    await act(async () => mockInput.pressKey('d'));
    await flush();
    expect(captureCharFrame()).toContain('Start App');
    await act(async () => mockInput.pressKey('y'));
    await flush();
    expect(changes).toEqual([
      ['app-1', 'stopped'],
      ['app-2', 'running'],
    ]);
    renderer.destroy();
  });

  test('v picks an access mode and marks the current one', async () => {
    const applied: Array<[string, string]> = [];
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <AppsView {...props({ onSetVisibility: (row, mode) => applied.push([row.id, mode]) })} />,
      SIZE,
    );
    await flush();
    await act(async () => mockInput.pressKey('v'));
    await flush();
    const frame = captureCharFrame();
    expect(frame).toContain('Who may open this App');
    expect(frame).toContain('private — Just you');
    expect(frame).toMatch(/project — Whole team\s+current/);

    // The cursor starts on the current mode; move up to `private` and apply.
    await act(async () => mockInput.pressKey('k'));
    await flush();
    await act(async () => mockInput.pressEnter());
    await flush();
    expect(applied).toEqual([['app-1', 'private']]);
    renderer.destroy();
  });

  test('v does nothing when the caller offers no modes', async () => {
    const applied: string[] = [];
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <AppsView
        {...props({ visibilityOptions: [], onSetVisibility: (_row, mode) => applied.push(mode) })}
      />,
      SIZE,
    );
    await flush();
    await act(async () => mockInput.pressKey('v'));
    await flush();
    expect(captureCharFrame()).not.toContain('Who may open this App');
    expect(applied).toEqual([]);
    renderer.destroy();
  });

  test('Esc with nothing open leaves the screen', async () => {
    let back = 0;
    const { flush, mockInput, renderer } = await testRender(
      <AppsView
        {...props({
          onBack: () => {
            back += 1;
          },
        })}
      />,
      SIZE,
    );
    await flush();
    await pressEscape(mockInput);
    await flush();
    expect(back).toBe(1);
    renderer.destroy();
  });

  test('an unfocused screen ignores keys', async () => {
    const opened: string[] = [];
    const { flush, mockInput, renderer } = await testRender(
      <AppsView {...props({ focused: false, onOpenUrl: (row) => opened.push(row.url) })} />,
      SIZE,
    );
    await flush();
    await act(async () => mockInput.pressKey('o'));
    await flush();
    expect(opened).toEqual([]);
    renderer.destroy();
  });

  test('loading, empty and error states each render their own body', async () => {
    const loading = await testRender(<AppsView {...props({ rows: [], loading: true })} />, SIZE);
    await loading.flush();
    expect(loading.captureCharFrame()).toContain('loading Apps');
    loading.renderer.destroy();

    const empty = await testRender(<AppsView {...props({ rows: [] })} />, SIZE);
    await empty.flush();
    const frame = empty.captureCharFrame();
    expect(frame).toContain('No Apps yet');
    expect(frame).toContain(FIRST_DEPLOY_COMMAND);
    empty.renderer.destroy();

    const failed = await testRender(
      <AppsView {...props({ rows: [], errorMessage: 'HTTP 403 forbidden' })} />,
      SIZE,
    );
    await failed.flush();
    expect(failed.captureCharFrame()).toContain('HTTP 403 forbidden');
    failed.renderer.destroy();
  });
});

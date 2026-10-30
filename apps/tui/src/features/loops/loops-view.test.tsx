import { describe, expect, test } from 'bun:test';
import { act } from 'react';

import { testRender } from '@opentui/react/test-utils';

import { scheduleText, toRow } from './loops-screen.tsx';
import {
  type LoopRow,
  LoopsView,
  type LoopsViewProps,
  loopRowText,
  untilText,
} from './loops-view.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date(2026, 8, 17, 12, 0, 0).getTime();
const MINUTE = 60_000;
const HOUR = 3_600_000;
const SIZE = { width: 84, height: 24 };

function rows(): LoopRow[] {
  return [
    {
      id: 'reminder.a1',
      title: 'Did the email arrive?',
      prompt: 'Did the email arrive?\nCheck the inbox.',
      schedule: 'every 1h',
      timezone: 'UTC',
      state: 'active',
      nextMs: NOW + 20 * MINUTE,
      lastMs: NOW - 40 * MINUTE,
      lastStatus: 'ok',
      lastError: null,
    },
    {
      id: 'reminder.b2',
      title: 'Daily digest',
      prompt: 'Summarize the day.',
      schedule: 'cron 0 9 * * *',
      timezone: 'Europe/Berlin',
      state: 'paused',
      nextMs: Number.NaN,
      lastMs: NOW - 5 * HOUR,
      lastStatus: 'error',
      lastError: 'session failed',
    },
  ];
}

function props(overrides: Partial<LoopsViewProps> = {}): LoopsViewProps {
  return {
    rows: rows(),
    focused: true,
    width: 82,
    height: 20,
    now: NOW,
    loading: false,
    errorMessage: null,
    onCreate: () => {},
    onToggle: () => {},
    onRun: () => {},
    onDelete: () => {},
    onRefresh: () => {},
    onBack: () => {},
    ...overrides,
  };
}

async function type(mockInput: { pressKey: (k: string) => void }, text: string) {
  for (const char of text) await act(async () => mockInput.pressKey(char));
}

describe('helpers', () => {
  test('untilText counts up to the next run', () => {
    expect([
      untilText(NOW + 20 * MINUTE, NOW),
      untilText(NOW + 3 * HOUR, NOW),
      untilText(NOW + 72 * HOUR, NOW),
      untilText(NOW - 1, NOW),
      untilText(Number.NaN, NOW),
    ]).toEqual(['in 20m', 'in 3h', 'in 3d', 'due', '—']);
  });

  test('scheduleText and toRow read the reminder fields', () => {
    const base = {
      id: 'reminder.x',
      session_id: 's',
      name: null,
      prompt: 'Ping\nsecond line',
      every: null,
      every_seconds: null,
      cron: null,
      timezone: 'UTC',
      at: null,
      state: 'active' as const,
      next_fire_at: '2026-09-17T12:20:00.000Z',
      last_fired_at: null,
      last_status: null,
      last_error: null,
      created_by: null,
      created_at: null,
    };
    expect(scheduleText({ ...base, every: '30m' })).toBe('every 30m');
    expect(scheduleText({ ...base, cron: '0 9 * * *' })).toBe('cron 0 9 * * *');
    expect(scheduleText({ ...base, at: '2026-11-02T09:00:00Z' })).toBe('once 2026-11-02 09:00');
    const row = toRow({ ...base, every: '30m' });
    expect(row).toMatchObject({ title: 'Ping', schedule: 'every 30m', state: 'active' });
    expect(row.nextMs).toBe(Date.parse('2026-09-17T12:20:00.000Z'));
  });

  test('loopRowText fits the width and ends with the next run or the state', () => {
    const [active, paused] = rows() as [LoopRow, LoopRow];
    const a = loopRowText(active, NOW, 82);
    expect(a.trimEnd().endsWith('next in 20m')).toBe(true);
    expect(a.length).toBeLessThanOrEqual(81);
    expect(loopRowText(paused, NOW, 82).trimEnd().endsWith('paused')).toBe(true);
  });
});

describe('<LoopsView/> through the OpenTUI test renderer', () => {
  test('lists each loop with its schedule and next run', async () => {
    const { captureCharFrame, flush, renderer } = await testRender(
      <LoopsView {...props()} />,
      SIZE,
    );
    await flush();
    const frame = captureCharFrame();
    expect(frame).toContain('Did the email arrive?');
    expect(frame).toContain('every 1h');
    expect(frame).toContain('next in 20m');
    expect(frame).toContain('cron 0 9 * * *');
    expect(frame).toContain('paused');
    renderer.destroy();
  });

  test('Space toggles, x runs, and the cursor chooses the loop', async () => {
    const calls: string[] = [];
    const { flush, mockInput, renderer } = await testRender(
      <LoopsView
        {...props({
          onToggle: (row) => calls.push(`toggle ${row.id}`),
          onRun: (row) => calls.push(`run ${row.id}`),
        })}
      />,
      SIZE,
    );
    await flush();
    await act(async () => mockInput.pressKey(' '));
    await act(async () => mockInput.pressKey('j'));
    await act(async () => mockInput.pressKey('x'));
    expect(calls).toEqual(['toggle reminder.a1', 'run reminder.b2']);
    renderer.destroy();
  });

  test('d asks first; y deletes, n keeps', async () => {
    const deleted: string[] = [];
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <LoopsView {...props({ onDelete: (row) => deleted.push(row.id) })} />,
      SIZE,
    );
    await flush();
    await act(async () => mockInput.pressKey('d'));
    await flush();
    expect(captureCharFrame()).toContain('y delete');
    await act(async () => mockInput.pressKey('n'));
    expect(deleted).toEqual([]);
    await act(async () => mockInput.pressKey('d'));
    await act(async () => mockInput.pressKey('y'));
    expect(deleted).toEqual(['reminder.a1']);
    renderer.destroy();
  });

  test('n opens the form; a valid prompt and schedule create the loop', async () => {
    const created: Array<{ prompt: string; schedule: string }> = [];
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <LoopsView {...props({ onCreate: (input) => created.push(input) })} />,
      SIZE,
    );
    await flush();
    await act(async () => mockInput.pressKey('n'));
    await flush();
    expect(captureCharFrame()).toContain('New loop');
    await type(mockInput, 'Check build');
    await act(async () => mockInput.pressEnter());
    await type(mockInput, 'every 30m');
    await flush();
    expect(captureCharFrame()).toContain('every 30m');
    await act(async () => mockInput.pressEnter());
    await flush();
    expect(created).toEqual([{ prompt: 'Check build', schedule: 'every 30m' }]);
    renderer.destroy();
  });

  test('a bad schedule stays in the form and says why', async () => {
    const created: unknown[] = [];
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <LoopsView {...props({ onCreate: (input) => created.push(input) })} />,
      SIZE,
    );
    await flush();
    await act(async () => mockInput.pressKey('n'));
    await type(mockInput, 'Check');
    await act(async () => mockInput.pressEnter());
    await type(mockInput, 'every 1m');
    await act(async () => mockInput.pressEnter());
    await flush();
    expect(created).toEqual([]);
    expect(captureCharFrame()).toContain('at most once every 5m');
    renderer.destroy();
  });

  test('Enter shows the full prompt and the last error', async () => {
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <LoopsView {...props()} />,
      SIZE,
    );
    await flush();
    await act(async () => mockInput.pressKey('j'));
    await act(async () => mockInput.pressEnter());
    await flush();
    const frame = captureCharFrame();
    expect(frame).toContain('Europe/Berlin');
    expect(frame).toContain('session failed');
    expect(frame).toContain('Summarize the day.');
    renderer.destroy();
  });

  test('loading, error and empty states each say what is happening', async () => {
    const loading = await testRender(<LoopsView {...props({ rows: [], loading: true })} />, SIZE);
    await loading.flush();
    expect(loading.captureCharFrame()).toContain('loading loops');
    loading.renderer.destroy();

    const failed = await testRender(
      <LoopsView {...props({ rows: [], errorMessage: 'HTTP 403: feature_disabled' })} />,
      SIZE,
    );
    await failed.flush();
    expect(failed.captureCharFrame()).toContain('HTTP 403: feature_disabled');
    failed.renderer.destroy();

    const empty = await testRender(<LoopsView {...props({ rows: [] })} />, SIZE);
    await empty.flush();
    expect(empty.captureCharFrame()).toContain('No loops in this session');
    empty.renderer.destroy();
  });
});

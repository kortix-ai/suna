import { describe, expect, test } from 'bun:test';
import { act } from 'react';

import { testRender } from '@opentui/react/test-utils';

import { editText } from './edit-text.ts';
import type { GoalDetail, GoalRow } from './goals-model.ts';
import { GoalsView, type GoalsViewProps, goalRowText, listLines } from './goals-view.tsx';
import { GOALS_KEYS } from './keys.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date(2026, 8, 17, 12, 0, 0).getTime();
const SIZE = { width: 84, height: 24 };

function rows(): GoalRow[] {
  return [
    {
      id: 'company/ask',
      title: 'Pick a payroll vendor',
      group: 'needs_you',
      glyph: '!',
      tone: 'busy',
      status: 'Waiting on you',
      progress: '0/3',
      line: 'Waiting for: vendor shortlist',
      agent: 'ops',
    },
    {
      id: 'company/close',
      title: 'Close the books',
      group: 'open',
      glyph: '●',
      tone: 'ok',
      status: 'Active',
      progress: '1/2',
      line: 'Reconciling.',
      agent: null,
    },
    {
      id: 'company/old',
      title: 'Old migration',
      group: 'closed',
      glyph: '○',
      tone: 'idle',
      status: 'Done',
      progress: '2/2',
      line: 'Finished.',
      agent: null,
    },
  ];
}

function detail(overrides: Partial<GoalDetail> = {}): GoalDetail {
  return {
    id: 'company/close',
    title: 'Close the books',
    status: 'Active',
    group: 'open',
    summary: 'Reconciling accounts.',
    agent: 'finance',
    waitingOn: null,
    issues: [],
    nextWake: null,
    criteria: [
      { text: 'All reconciled', met: true, evidence: null },
      { text: 'Signed off', met: false, evidence: null },
    ],
    asks: [],
    sessions: [
      { id: 'sess-new', role: 'owner', since: '2026-09-16T00:00:00Z' },
      { id: 'sess-old', role: 'verifier', since: '2026-09-15T00:00:00Z' },
    ],
    links: [],
    folder: '/Company/Goals/close',
    canReply: true,
    canStop: true,
    files: { loading: false, verification: null, log: null },
    ...overrides,
  };
}

function props(overrides: Partial<GoalsViewProps> = {}): GoalsViewProps {
  return {
    rows: rows(),
    focused: true,
    width: 82,
    height: 20,
    now: NOW,
    loading: false,
    errorMessage: null,
    detail: null,
    onOpenDetails: () => {},
    onOpenSession: () => {},
    onCreate: () => {},
    onReply: () => {},
    onStop: () => {},
    onOpenWeb: () => {},
    onRefresh: () => {},
    onBack: () => {},
    ...overrides,
  };
}

async function pressEscape(mockInput: { pressEscape: () => void }): Promise<void> {
  await act(async () => {
    mockInput.pressEscape();
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
}

describe('listLines / goalRowText', () => {
  test('inserts one header per group with its count', () => {
    const lines = listLines(rows());
    expect(lines.map((l) => (l.kind === 'header' ? `${l.label} ${l.count}` : l.row.id))).toEqual([
      'Needs you 1',
      'company/ask',
      'Open 1',
      'company/close',
      'Closed 1',
      'company/old',
    ]);
  });

  test('a row puts progress and status flush right inside the width', () => {
    const text = goalRowText(rows()[1] as GoalRow, 60);
    expect(text.startsWith('● Close the books')).toBe(true);
    expect(text.trimEnd().endsWith('1/2 · Active')).toBe(true);
    expect(text.length).toBeLessThanOrEqual(59);
  });
});

describe('<GoalsView/> list', () => {
  test('draws group headers, rows and the selected row line', async () => {
    const { captureCharFrame, flush, renderer } = await testRender(
      <GoalsView {...props()} />,
      SIZE,
    );
    await flush();
    const frame = captureCharFrame();
    expect(frame).toContain('Needs you 1');
    expect(frame).toContain('Pick a payroll vendor');
    expect(frame).toContain('0/3 · Waiting on you');
    expect(frame).toContain('Closed 1');
    // The cursor row's reason sits under the list.
    expect(frame).toContain('Waiting for: vendor shortlist');
    renderer.destroy();
  });

  test('j moves the cursor and the reason line follows', async () => {
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <GoalsView {...props()} />,
      SIZE,
    );
    await flush();
    await act(async () => mockInput.pressKey('j'));
    await flush();
    const marked = captureCharFrame()
      .split('\n')
      .find((line) => line.startsWith('▌'));
    expect(marked).toContain('Close the books');
    expect(captureCharFrame()).toContain('Reconciling.');
    renderer.destroy();
  });

  test('loading, error and empty states', async () => {
    const loading = await testRender(<GoalsView {...props({ rows: [], loading: true })} />, SIZE);
    await loading.flush();
    expect(loading.captureCharFrame()).toContain('loading goals');
    loading.renderer.destroy();

    const failed = await testRender(
      <GoalsView {...props({ rows: [], errorMessage: 'HTTP 502: bad gateway' })} />,
      SIZE,
    );
    await failed.flush();
    expect(failed.captureCharFrame()).toContain('HTTP 502: bad gateway');
    failed.renderer.destroy();

    const empty = await testRender(
      <GoalsView {...props({ rows: [], emptyHint: 'n  start a goal' })} />,
      SIZE,
    );
    await empty.flush();
    expect(empty.captureCharFrame()).toContain('No goals yet');
    expect(empty.captureCharFrame()).toContain('n  start a goal');
    empty.renderer.destroy();
  });

  test('an unfocused view ignores keys', async () => {
    const asked: Array<string | null> = [];
    const { flush, mockInput, renderer } = await testRender(
      <GoalsView {...props({ focused: false, onOpenDetails: (id) => asked.push(id) })} />,
      SIZE,
    );
    await flush();
    await act(async () => mockInput.pressEnter());
    await flush();
    expect(asked).toEqual([]);
    renderer.destroy();
  });

  test('Esc with nothing open calls onBack', async () => {
    let backs = 0;
    const { flush, mockInput, renderer } = await testRender(
      <GoalsView {...props({ onBack: () => backs++ })} />,
      SIZE,
    );
    await flush();
    await pressEscape(mockInput);
    expect(backs).toBe(1);
    renderer.destroy();
  });
});

describe('<GoalsView/> new goal', () => {
  test('n opens the outcome input; Enter sends the typed text', async () => {
    const created: string[] = [];
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <GoalsView {...props({ onCreate: (text) => created.push(text) })} />,
      SIZE,
    );
    await flush();
    await act(async () => mockInput.pressKey('n'));
    await flush();
    expect(captureCharFrame()).toContain('Outcome ›');

    // Empty text does not submit.
    await act(async () => mockInput.pressEnter());
    await flush();
    expect(created).toEqual([]);

    await act(async () => mockInput.typeText('Ship the v2 docs'));
    await flush();
    expect(captureCharFrame()).toContain('Ship the v2 docs');
    await act(async () => mockInput.pressEnter());
    await flush();
    expect(created).toEqual(['Ship the v2 docs']);
    expect(captureCharFrame()).not.toContain('Outcome ›');
    renderer.destroy();
  });

  test('Esc cancels the input without calling onCreate or onBack', async () => {
    let backs = 0;
    const created: string[] = [];
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <GoalsView {...props({ onBack: () => backs++, onCreate: (text) => created.push(text) })} />,
      SIZE,
    );
    await flush();
    await act(async () => mockInput.pressKey('n'));
    await act(async () => mockInput.typeText('abc'));
    await pressEscape(mockInput);
    await flush();
    expect(created).toEqual([]);
    expect(backs).toBe(0);
    expect(captureCharFrame()).not.toContain('Outcome ›');
    renderer.destroy();
  });
});

describe('<GoalsView/> detail', () => {
  async function openDetail(overrides: Partial<GoalsViewProps> = {}) {
    const calls = {
      opened: [] as Array<string | null>,
      sessions: [] as string[],
      replies: [] as Array<[string, string]>,
      stops: [] as Array<[string, string]>,
      web: [] as string[],
    };
    const view = await testRender(
      <GoalsView
        {...props({
          rows: rows().slice(1),
          detail: detail(),
          onOpenDetails: (id) => calls.opened.push(id),
          onOpenSession: (id) => calls.sessions.push(id),
          onReply: (id, text) => calls.replies.push([id, text]),
          onStop: (id, reason) => calls.stops.push([id, reason]),
          onOpenWeb: (id) => calls.web.push(id),
          ...overrides,
        })}
      />,
      SIZE,
    );
    await view.flush();
    await act(async () => view.mockInput.pressEnter());
    await view.flush();
    return { ...view, calls };
  }

  test('Enter opens the detail for the cursor goal and draws criteria and sessions', async () => {
    const { captureCharFrame, calls, renderer } = await openDetail();
    expect(calls.opened).toEqual(['company/close']);
    const frame = captureCharFrame();
    expect(frame).toContain('Done when · 1/2');
    expect(frame).toContain('[x] All reconciled');
    expect(frame).toContain('[ ] Signed off');
    expect(frame).toContain('owner    sess-new');
    expect(frame).toContain('verifier sess-old');
    renderer.destroy();
  });

  test('Enter on a linked session opens it; Enter elsewhere does nothing', async () => {
    const { flush, mockInput, calls, renderer } = await openDetail();
    await act(async () => mockInput.pressEnter());
    await flush();
    expect(calls.sessions).toEqual([]);

    // Move down to the session line.
    for (let i = 0; i < 40 && calls.sessions.length === 0; i++) {
      await act(async () => mockInput.pressKey('j'));
      await act(async () => mockInput.pressEnter());
    }
    expect(calls.sessions[0]).toBe('sess-new');
    renderer.destroy();
  });

  test('a types an answer and Enter sends it with the goal id', async () => {
    const { captureCharFrame, flush, mockInput, calls, renderer } = await openDetail();
    await act(async () => mockInput.pressKey('a'));
    await flush();
    expect(captureCharFrame()).toContain('Answer ›');
    await act(async () => mockInput.typeText('Use Gusto'));
    await act(async () => mockInput.pressEnter());
    await flush();
    expect(calls.replies).toEqual([['company/close', 'Use Gusto']]);
    renderer.destroy();
  });

  test('s asks for a reason; Enter with none stops with an empty reason', async () => {
    const { captureCharFrame, flush, mockInput, calls, renderer } = await openDetail();
    await act(async () => mockInput.pressKey('s'));
    await flush();
    expect(captureCharFrame()).toContain('Stop reason (optional)');
    await act(async () => mockInput.pressEnter());
    await flush();
    expect(calls.stops).toEqual([['company/close', '']]);
    renderer.destroy();
  });

  test('a and s are inert when the goal cannot be answered or stopped', async () => {
    const { captureCharFrame, flush, mockInput, calls, renderer } = await openDetail({
      detail: detail({ canReply: false, canStop: false }),
    });
    await act(async () => mockInput.pressKey('a'));
    await act(async () => mockInput.pressKey('s'));
    await flush();
    const frame = captureCharFrame();
    expect(frame).not.toContain('Answer ›');
    expect(frame).not.toContain('Stop reason');
    expect(calls.replies).toEqual([]);
    expect(calls.stops).toEqual([]);
    renderer.destroy();
  });

  test('o opens the goal in the browser and Esc closes the pane', async () => {
    const { captureCharFrame, flush, mockInput, calls, renderer } = await openDetail();
    await act(async () => mockInput.pressKey('o'));
    await flush();
    expect(calls.web).toEqual(['company/close']);
    await pressEscape(mockInput);
    await flush();
    expect(calls.opened).toEqual(['company/close', null]);
    expect(captureCharFrame()).toContain('Close the books');
    expect(captureCharFrame()).not.toContain('Done when');
    renderer.destroy();
  });
});

describe('editText', () => {
  const key = (over: Record<string, unknown>) =>
    ({
      name: '',
      sequence: '',
      ctrl: false,
      meta: false,
      option: false,
      shift: false,
      ...over,
    }) as never;

  test('appends printable text, deletes with backspace, clears with ctrl+u', () => {
    expect(editText('ab', key({ name: 'c', sequence: 'c' }))).toBe('abc');
    expect(editText('ab', key({ name: 'backspace' }))).toBe('a');
    expect(editText('ab', key({ name: 'u', ctrl: true, sequence: '\u0015' }))).toBe('');
  });

  test('ignores control bytes and modified keys', () => {
    expect(editText('ab', key({ name: 'escape', sequence: '\u001b' }))).toBeNull();
    expect(editText('ab', key({ name: 'x', sequence: 'x', meta: true }))).toBeNull();
  });
});

describe('GOALS_KEYS', () => {
  test('every id is unique per chord set and scoped goals', () => {
    const ids = GOALS_KEYS.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(GOALS_KEYS.every((b) => b.scope === 'goals')).toBe(true);
  });
});

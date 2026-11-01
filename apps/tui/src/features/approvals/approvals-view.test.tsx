import { describe, expect, test } from 'bun:test';
import { act } from 'react';

import type { ReviewItem } from '@kortix/sdk';
import { testRender } from '@opentui/react/test-utils';

import type { ApprovalRow, Verb } from './approvals-model.ts';
import { toApprovalRow } from './approvals-model.ts';
import {
  type ApprovalDetail,
  ApprovalsView,
  type ApprovalsViewProps,
  approvalRowText,
  listLines,
} from './approvals-view.tsx';
import { APPROVALS_KEYS } from './keys.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date(2026, 8, 17, 12, 0, 0).getTime();
const SIZE = { width: 84, height: 24 };
const iso = (ms: number) => new Date(ms).toISOString();

const callItem = {
  id: 'call:exec-1',
  kind: 'approval',
  title: 'Send email',
  summary: 'From a running session',
  risk: 'high',
  status: 'needs_you',
  source: 'agent',
  agent: 'ops',
  createdAt: iso(NOW - 3 * 60_000),
  sessionId: 's-1',
  detail: {
    actions: [
      {
        id: 'a1',
        title: 'Send email',
        connector: 'gmail',
        action: 'send_email',
        consequence: 'Sends one email to 40 people.',
        risk: 'high',
        icon: 'email',
        argsPreview: [{ key: 'to', value: 'team@example.test' }],
        policySource: 'approve',
      },
    ],
  },
} as unknown as ReviewItem;

const decisionItem = {
  id: 'ri-2',
  kind: 'decision',
  title: 'Which bank?',
  summary: 'Pick one',
  risk: 'none',
  status: 'needs_you',
  source: 'agent',
  agent: 'ops',
  createdAt: iso(NOW - 2 * 3_600_000),
  detail: {
    question: 'Which bank?',
    options: [
      { id: 'o1', label: 'Mercury' },
      { id: 'o2', label: 'Brex' },
    ],
  },
} as unknown as ReviewItem;

const outputItem = {
  id: 'ri-3',
  kind: 'output',
  title: 'Q3 report',
  summary: 'Draft',
  risk: 'low',
  status: 'needs_you',
  source: 'agent',
  agent: 'writer',
  createdAt: iso(NOW - 26 * 3_600_000),
  detail: { artifactKind: 'document', artifactLabel: 'Q3 report', note: 'Draft for review.' },
} as unknown as ReviewItem;

const ITEMS = [callItem, outputItem, decisionItem];

function rows(): ApprovalRow[] {
  return ITEMS.map(toApprovalRow);
}

function props(overrides: Partial<ApprovalsViewProps> = {}): ApprovalsViewProps {
  return {
    rows: rows(),
    segment: 'needs_you',
    needsYouCount: 3,
    focused: true,
    width: 82,
    height: 22,
    now: NOW,
    loading: false,
    errorMessage: null,
    hasMore: false,
    detail: null,
    onSegmentChange: () => {},
    onOpenDetails: () => {},
    onAct: () => {},
    onOpenSession: () => {},
    onOpenWeb: () => {},
    onLoadMore: () => {},
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

/** Render with the detail of `item` already in place, then press Enter to open it. */
async function openDetail(item: ReviewItem, overrides: Partial<ApprovalsViewProps> = {}) {
  const calls = {
    opened: [] as Array<string | null>,
    acts: [] as Array<[string, Verb, string]>,
    sessions: [] as string[],
    web: [] as string[],
  };
  const detail: ApprovalDetail = { item, loading: false };
  const view = await testRender(
    <ApprovalsView
      {...props({
        rows: [toApprovalRow(item)],
        detail,
        onOpenDetails: (id) => calls.opened.push(id),
        onAct: (id, verb, text) => calls.acts.push([id, verb, text]),
        onOpenSession: (id) => calls.sessions.push(id),
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

describe('list rendering', () => {
  test('groups by kind with counts and prints the tabs with the needs-you total', async () => {
    const { captureCharFrame, flush, renderer } = await testRender(
      <ApprovalsView {...props()} />,
      SIZE,
    );
    await flush();
    const frame = captureCharFrame();
    expect(frame).toContain('Needs you 3');
    expect(frame).toContain('Waiting');
    expect(frame).toContain('Approvals 1');
    expect(frame).toContain('Outputs 1');
    expect(frame).toContain('Decisions 1');
    expect(frame).toContain('Send email');
    expect(frame).toContain('high · ops · 3m');
    expect(frame).toContain('From a running session');
    renderer.destroy();
  });

  test('listLines puts one header before each kind', () => {
    expect(listLines(rows()).map((l) => (l.kind === 'header' ? l.label : l.row.id))).toEqual([
      'Approvals',
      'call:exec-1',
      'Outputs',
      'ri-3',
      'Decisions',
      'ri-2',
    ]);
  });

  test('a row fits the width', () => {
    expect(approvalRowText(rows()[0] as ApprovalRow, NOW, 60).length).toBeLessThanOrEqual(59);
  });

  test('l, h and Tab walk the segments', async () => {
    const seen: string[] = [];
    const { flush, mockInput, renderer } = await testRender(
      <ApprovalsView {...props({ onSegmentChange: (s) => seen.push(s) })} />,
      SIZE,
    );
    await flush();
    await act(async () => mockInput.pressKey('l'));
    await act(async () => mockInput.pressKey('h'));
    await act(async () => mockInput.pressTab());
    expect(seen).toEqual(['waiting', 'done', 'waiting']);
    renderer.destroy();
  });

  test('loading, error and per-segment empty states', async () => {
    const loading = await testRender(
      <ApprovalsView {...props({ rows: [], loading: true })} />,
      SIZE,
    );
    await loading.flush();
    expect(loading.captureCharFrame()).toContain('loading review items');
    loading.renderer.destroy();

    const failed = await testRender(
      <ApprovalsView {...props({ rows: [], errorMessage: 'HTTP 403: forbidden' })} />,
      SIZE,
    );
    await failed.flush();
    expect(failed.captureCharFrame()).toContain('HTTP 403: forbidden');
    failed.renderer.destroy();

    const empty = await testRender(
      <ApprovalsView {...props({ rows: [], segment: 'waiting' })} />,
      SIZE,
    );
    await empty.flush();
    expect(empty.captureCharFrame()).toContain('Nothing is waiting');
    empty.renderer.destroy();
  });

  test('reaching the last row asks for the next page when there is one', async () => {
    let more = 0;
    const { flush, mockInput, renderer } = await testRender(
      <ApprovalsView {...props({ hasMore: true, onLoadMore: () => more++ })} />,
      SIZE,
    );
    await flush();
    await act(async () => mockInput.pressKey('G'));
    expect(more).toBe(1);
    renderer.destroy();
  });

  test('an unfocused view ignores keys', async () => {
    const opened: Array<string | null> = [];
    const { flush, mockInput, renderer } = await testRender(
      <ApprovalsView {...props({ focused: false, onOpenDetails: (id) => opened.push(id) })} />,
      SIZE,
    );
    await flush();
    await act(async () => mockInput.pressEnter());
    expect(opened).toEqual([]);
    renderer.destroy();
  });

  test('a verdict key in the list does nothing: approvals are decided in the detail', async () => {
    const acts: unknown[] = [];
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <ApprovalsView {...props({ onAct: (...args) => acts.push(args) })} />,
      SIZE,
    );
    await flush();
    await act(async () => mockInput.pressKey('a'));
    await flush();
    expect(acts).toEqual([]);
    expect(captureCharFrame()).not.toContain('Approve "');
    renderer.destroy();
  });
});

describe('detail and verdicts', () => {
  test('Enter opens the detail for the cursor item and prints the call parameters', async () => {
    const { captureCharFrame, calls, renderer } = await openDetail(callItem);
    expect(calls.opened).toEqual(['call:exec-1']);
    const frame = captureCharFrame();
    expect(frame).toContain('Sends one email to 40 people.');
    expect(frame).toContain('to: team@example.test');
    expect(frame).toContain('a approve');
    expect(frame).toContain('x reject');
    renderer.destroy();
  });

  test('a asks first; y approves with the item id and closes the pane', async () => {
    const { captureCharFrame, flush, mockInput, calls, renderer } = await openDetail(callItem);
    await act(async () => mockInput.pressKey('a'));
    await flush();
    expect(captureCharFrame()).toContain('Approve "Send email"?');
    expect(calls.acts).toEqual([]);
    await act(async () => mockInput.pressKey('y'));
    await flush();
    expect(calls.acts).toEqual([['call:exec-1', 'approve', '']]);
    expect(calls.opened).toEqual(['call:exec-1', null]);
    renderer.destroy();
  });

  test('n declines the confirm and keeps the pane', async () => {
    const { captureCharFrame, flush, mockInput, calls, renderer } = await openDetail(callItem);
    await act(async () => mockInput.pressKey('a'));
    await act(async () => mockInput.pressKey('n'));
    await flush();
    expect(calls.acts).toEqual([]);
    expect(captureCharFrame()).toContain('Sends one email to 40 people.');
    renderer.destroy();
  });

  test('x takes an optional reason and sends it', async () => {
    const { captureCharFrame, flush, mockInput, calls, renderer } = await openDetail(callItem);
    await act(async () => mockInput.pressKey('x'));
    await flush();
    expect(captureCharFrame()).toContain('Reject. Reason (optional) ›');
    await act(async () => mockInput.typeText('wrong list'));
    await act(async () => mockInput.pressEnter());
    await flush();
    expect(calls.acts).toEqual([['call:exec-1', 'reject', 'wrong list']]);
    renderer.destroy();
  });

  test('x with no reason still rejects', async () => {
    const { flush, mockInput, calls, renderer } = await openDetail(callItem);
    await act(async () => mockInput.pressKey('x'));
    await act(async () => mockInput.pressEnter());
    await flush();
    expect(calls.acts).toEqual([['call:exec-1', 'reject', '']]);
    renderer.destroy();
  });

  test('c needs a note: Enter on an empty input does not send', async () => {
    const { flush, mockInput, calls, renderer } = await openDetail(outputItem);
    await act(async () => mockInput.pressKey('c'));
    await act(async () => mockInput.pressEnter());
    await flush();
    expect(calls.acts).toEqual([]);
    await act(async () => mockInput.typeText('add a chart'));
    await act(async () => mockInput.pressEnter());
    await flush();
    expect(calls.acts).toEqual([['ri-3', 'changes', 'add a chart']]);
    renderer.destroy();
  });

  test('Esc in an input returns to the detail without sending', async () => {
    const { captureCharFrame, flush, mockInput, calls, renderer } = await openDetail(outputItem);
    await act(async () => mockInput.pressKey('c'));
    await act(async () => mockInput.typeText('abc'));
    await pressEscape(mockInput);
    await flush();
    expect(calls.acts).toEqual([]);
    expect(calls.opened).toEqual(['ri-3']);
    expect(captureCharFrame()).toContain('Draft for review.');
    renderer.destroy();
  });

  test('a digit picks a decision option, asks, then answers with its label', async () => {
    const { captureCharFrame, flush, mockInput, calls, renderer } = await openDetail(decisionItem);
    expect(captureCharFrame()).toContain('1. Mercury');
    await act(async () => mockInput.pressKey('2'));
    await flush();
    expect(captureCharFrame()).toContain('Answer "Brex"?');
    await act(async () => mockInput.pressEnter());
    await flush();
    expect(calls.acts).toEqual([['ri-2', 'answer', 'Brex']]);
    renderer.destroy();
  });

  test('a digit past the last option does nothing', async () => {
    const { flush, mockInput, calls, renderer } = await openDetail(decisionItem);
    await act(async () => mockInput.pressKey('9'));
    await flush();
    expect(calls.acts).toEqual([]);
    renderer.destroy();
  });

  test('w answers a decision in free text', async () => {
    const { flush, mockInput, calls, renderer } = await openDetail(decisionItem);
    await act(async () => mockInput.pressKey('w'));
    await act(async () => mockInput.typeText('Neither, use Relay'));
    await act(async () => mockInput.pressEnter());
    await flush();
    expect(calls.acts).toEqual([['ri-2', 'answer', 'Neither, use Relay']]);
    renderer.destroy();
  });

  test('a verb the item does not allow is inert', async () => {
    const { captureCharFrame, flush, mockInput, calls, renderer } = await openDetail(callItem);
    // A connector call cannot be dismissed or sent back for changes.
    await act(async () => mockInput.pressKey('d'));
    await act(async () => mockInput.pressKey('c'));
    await flush();
    expect(calls.acts).toEqual([]);
    expect(captureCharFrame()).not.toContain('Dismiss "');
    renderer.destroy();
  });

  test('a decided item reads only: no verb hints', async () => {
    const decided = { ...(outputItem as object), status: 'approved' } as unknown as ReviewItem;
    const { captureCharFrame, flush, mockInput, calls, renderer } = await openDetail(decided);
    await act(async () => mockInput.pressKey('a'));
    await flush();
    expect(calls.acts).toEqual([]);
    expect(captureCharFrame()).toContain('Read only');
    renderer.destroy();
  });

  test('s opens the source session and o the web page', async () => {
    const { flush, mockInput, calls, renderer } = await openDetail(callItem);
    await act(async () => mockInput.pressKey('s'));
    await act(async () => mockInput.pressKey('o'));
    await flush();
    expect(calls.sessions).toEqual(['s-1']);
    expect(calls.web).toEqual(['call:exec-1']);
    renderer.destroy();
  });

  test('an item with no session ignores s', async () => {
    const { flush, mockInput, calls, renderer } = await openDetail(decisionItem);
    await act(async () => mockInput.pressKey('s'));
    await flush();
    expect(calls.sessions).toEqual([]);
    renderer.destroy();
  });

  test('a connector call still loading shows the spinner', async () => {
    const view = await testRender(
      <ApprovalsView
        {...props({ rows: [toApprovalRow(callItem)], detail: { item: callItem, loading: true } })}
      />,
      SIZE,
    );
    await view.flush();
    await act(async () => view.mockInput.pressEnter());
    await view.flush();
    expect(view.captureCharFrame()).toContain('loading content');
    view.renderer.destroy();
  });
});

describe('APPROVALS_KEYS', () => {
  test('ids are unique and scoped approvals; the option binding covers 1 to 9', () => {
    const ids = APPROVALS_KEYS.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(APPROVALS_KEYS.every((b) => b.scope === 'approvals')).toBe(true);
    expect(APPROVALS_KEYS.find((b) => b.id === 'approvals.option')?.chords).toHaveLength(9);
  });
});

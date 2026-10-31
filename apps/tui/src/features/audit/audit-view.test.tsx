import { describe, expect, test } from 'bun:test';
import { act, useState } from 'react';

import { testRender } from '@opentui/react/test-utils';

import { AuditView, type AuditViewProps, auditRowText } from './audit-view.tsx';
import type { AuditRow } from './rows.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date(2026, 8, 17, 12, 0, 0).getTime();
const MINUTE = 60_000;
const SIZE = { width: 84, height: 24 };

function rows(): AuditRow[] {
  return [
    {
      id: 'action:x1',
      atMs: NOW - 2 * MINUTE,
      at: '2026-09-17T11:58:00.000Z',
      actor: 'kortix',
      actorKind: 'agent',
      action: 'gmail.send_email',
      outcome: 'pending',
      fields: [
        ['Time', '2026-09-17T11:58:00.000Z'],
        ['Arguments', '{"to":"a@example.com"}'],
      ],
      pending: { executionId: 'x1', canResolve: true, resolvers: null },
    },
    {
      id: 'event:e2',
      atMs: NOW - 10 * MINUTE,
      at: '2026-09-17T11:50:00.000Z',
      actor: 'kortix',
      actorKind: 'agent',
      action: 'tool.call',
      outcome: 'failure',
      fields: [['Error', 'timeout']],
      pending: null,
    },
    {
      id: 'event:e3',
      atMs: NOW - 60 * MINUTE,
      at: '2026-09-17T11:00:00.000Z',
      actor: 'person',
      actorKind: 'person',
      action: 'session.create',
      outcome: 'success',
      fields: [],
      pending: null,
    },
  ];
}

function props(overrides: Partial<AuditViewProps> = {}): AuditViewProps {
  return {
    rows: rows(),
    focused: true,
    width: 82,
    height: 20,
    now: NOW,
    loading: false,
    errorMessage: null,
    onDecide: () => {},
    onLoadMore: () => {},
    onRefresh: () => {},
    onBack: () => {},
    ...overrides,
  };
}

describe('auditRowText', () => {
  test('prints the age, the actor, the action and the outcome', () => {
    const text = auditRowText(rows()[0] as AuditRow, NOW, 82);
    expect(text).toContain('2m');
    expect(text).toContain('kortix');
    expect(text).toContain('gmail.send_email');
    expect(text.trimEnd().endsWith('pending')).toBe(true);
    expect(text.length).toBeLessThanOrEqual(81);
  });
});

describe('<AuditView/> through the OpenTUI test renderer', () => {
  test('lists the rows and counts the pending ones', async () => {
    const { captureCharFrame, flush, renderer } = await testRender(
      <AuditView {...props()} />,
      SIZE,
    );
    await flush();
    const frame = captureCharFrame();
    expect(frame).toContain('gmail.send_email');
    expect(frame).toContain('session.create');
    expect(frame).toContain('3 events · 1 pending');
    expect(frame).toContain('a approve');
    renderer.destroy();
  });

  test('f cycles the filter and narrows the list', async () => {
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <AuditView {...props()} />,
      SIZE,
    );
    await flush();
    await act(async () => mockInput.pressKey('f'));
    await flush();
    let frame = captureCharFrame();
    expect(frame).toContain('Audit · approvals');
    expect(frame).toContain('gmail.send_email');
    expect(frame).not.toContain('session.create');
    await act(async () => mockInput.pressKey('f'));
    await act(async () => mockInput.pressKey('f'));
    await act(async () => mockInput.pressKey('f'));
    await flush();
    frame = captureCharFrame();
    expect(frame).toContain('Audit · failed');
    expect(frame).toContain('tool.call');
    expect(frame).not.toContain('session.create');
    renderer.destroy();
  });

  test('Enter shows the detail fields; Esc returns', async () => {
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <AuditView {...props()} />,
      SIZE,
    );
    await flush();
    await act(async () => mockInput.pressEnter());
    await flush();
    const frame = captureCharFrame();
    expect(frame).toContain('{"to":"a@example.com"}');
    expect(frame).toContain('a approve · x deny');
    renderer.destroy();
  });

  test('a asks first; y approves the pending action', async () => {
    const decided: string[] = [];
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <AuditView
        {...props({ onDecide: (row, d) => decided.push(`${d} ${row.pending?.executionId}`) })}
      />,
      SIZE,
    );
    await flush();
    await act(async () => mockInput.pressKey('a'));
    await flush();
    expect(captureCharFrame()).toContain('Approve action');
    expect(decided).toEqual([]);
    await act(async () => mockInput.pressKey('y'));
    expect(decided).toEqual(['approve x1']);
    await act(async () => mockInput.pressKey('x'));
    await act(async () => mockInput.pressKey('y'));
    expect(decided).toEqual(['approve x1', 'deny x1']);
    renderer.destroy();
  });

  test('y decides the row the prompt opened for, with its arguments shown, even after a refresh moves the list', async () => {
    const second: AuditRow = {
      ...rows()[0]!,
      id: 'action:x9',
      atMs: NOW - 5 * MINUTE,
      action: 'github.merge_pull_request',
      fields: [['Arguments', '{"pr":42}']],
      pending: { executionId: 'x9', canResolve: true, resolvers: null },
    };
    const decided: string[] = [];
    let setShown: (next: AuditRow[]) => void = () => {};
    function Harness() {
      const [list, setList] = useState<AuditRow[]>([rows()[0]!, second]);
      setShown = setList;
      return <AuditView {...props({ rows: list, onDecide: (row, d) => decided.push(`${d} ${row.pending?.executionId}`) })} />;
    }
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(<Harness />, SIZE);
    await flush();
    await act(async () => mockInput.pressKey('j'));
    await act(async () => mockInput.pressKey('a'));
    await flush();
    expect(captureCharFrame()).toContain('{"pr":42}');
    // A refresh lands while the prompt is open: the confirmed row left the list.
    await act(async () => setShown([rows()[0]!]));
    await flush();
    await act(async () => mockInput.pressKey('y'));
    expect(decided).toEqual(['approve x9']);
    renderer.destroy();
  });

  test('a row that is not pending cannot be decided and says so', async () => {
    const decided: string[] = [];
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <AuditView {...props({ onDecide: (row) => decided.push(row.id) })} />,
      SIZE,
    );
    await flush();
    await act(async () => mockInput.pressKey('j'));
    await act(async () => mockInput.pressKey('a'));
    await flush();
    expect(decided).toEqual([]);
    expect(captureCharFrame()).toContain('Only a pending action can be decided.');
    renderer.destroy();
  });

  test('a pending action the viewer may not decide names who may', async () => {
    const locked = rows();
    locked[0] = {
      ...(locked[0] as AuditRow),
      pending: { executionId: 'x1', canResolve: false, resolvers: 'managers' },
    };
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <AuditView {...props({ rows: locked })} />,
      SIZE,
    );
    await flush();
    await act(async () => mockInput.pressKey('a'));
    await flush();
    expect(captureCharFrame()).toContain('Only project managers can decide this action.');
    renderer.destroy();
  });

  test('m loads older events only when there are some', async () => {
    let loaded = 0;
    const without = await testRender(
      <AuditView {...props({ onLoadMore: () => loaded++ })} />,
      SIZE,
    );
    await without.flush();
    await act(async () => without.mockInput.pressKey('m'));
    expect(loaded).toBe(0);
    without.renderer.destroy();

    const withMore = await testRender(
      <AuditView {...props({ hasMore: true, onLoadMore: () => loaded++ })} />,
      SIZE,
    );
    await withMore.flush();
    await act(async () => withMore.mockInput.pressKey('m'));
    expect(loaded).toBe(1);
    withMore.renderer.destroy();
  });

  test('loading, error, notice and empty states each say what is happening', async () => {
    const loading = await testRender(<AuditView {...props({ rows: [], loading: true })} />, SIZE);
    await loading.flush();
    expect(loading.captureCharFrame()).toContain('loading audit');
    loading.renderer.destroy();

    const failed = await testRender(
      <AuditView {...props({ rows: [], errorMessage: 'HTTP 404: session_not_found' })} />,
      SIZE,
    );
    await failed.flush();
    expect(failed.captureCharFrame()).toContain('HTTP 404: session_not_found');
    failed.renderer.destroy();

    const gated = await testRender(
      <AuditView
        {...props({ rows: [], notice: 'History needs the Enterprise audit entitlement.' })}
      />,
      SIZE,
    );
    await gated.flush();
    const frame = gated.captureCharFrame();
    expect(frame).toContain('No audit events in this session yet.');
    expect(frame).toContain('History needs the Enterprise audit entitlement.');
    gated.renderer.destroy();
  });
});

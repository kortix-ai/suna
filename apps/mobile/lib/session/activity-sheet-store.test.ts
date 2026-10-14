import { beforeEach, describe, expect, test } from 'bun:test';
import { blocksOf } from '@/lib/testing/session-log';

import { burstView } from './activity';
import { useActivitySheetStore } from './activity-sheet-store';

function tool(id: string): unknown {
  return {
    type: 'tool',
    id,
    callID: `call_${id}`,
    tool: 'bash',
    sessionID: 's',
    messageID: 'm',
    state: { status: 'completed', input: { command: id } },
  };
}

const burst = (...ids: string[]) => blocksOf(ids.map(tool));

const context = { sessionId: 's', turnLive: false };

describe('activity sheet store', () => {
  beforeEach(() => useActivitySheetStore.getState().close());

  test('starts closed', () => {
    expect(useActivitySheetStore.getState().sheet).toBeNull();
  });

  test('show opens the sheet for a burst', () => {
    const parts = burst('a', 'b');
    useActivitySheetStore.getState().show(parts, burstView(parts, false), context);
    const { sheet } = useActivitySheetStore.getState();
    expect(sheet?.blockIds).toEqual(['a', 'b']);
    expect(sheet?.callIds).toEqual(['call_a', 'call_b']);
    expect(sheet?.view.summary.total).toBe(2);
  });

  test('sync updates the sheet from a burst that shares a block, and remembers every call', () => {
    const { show, sync } = useActivitySheetStore.getState();
    const first = burst('a', 'b');
    show(first, burstView(first, true, true), context);
    // The pending call `a` left the burst; `c` arrived.
    const next = burst('b', 'c');
    sync(next, burstView(next, true, true), { ...context, turnLive: true });
    const { sheet } = useActivitySheetStore.getState();
    expect(sheet?.blockIds).toEqual(['b', 'c']);
    expect(sheet?.callIds).toEqual(['call_a', 'call_b', 'call_c']);
    expect(sheet?.context.turnLive).toBe(true);
  });

  test('sync from another burst changes nothing', () => {
    const { show, sync } = useActivitySheetStore.getState();
    const open = burst('a', 'b');
    show(open, burstView(open, false), context);
    const before = useActivitySheetStore.getState().sheet;
    const other = burst('x', 'y');
    sync(other, burstView(other, false), context);
    expect(useActivitySheetStore.getState().sheet).toBe(before);
  });

  test('sync while closed does not open the sheet', () => {
    const parts = burst('a', 'b');
    useActivitySheetStore.getState().sync(parts, burstView(parts, false), context);
    expect(useActivitySheetStore.getState().sheet).toBeNull();
  });

  test('close clears the sheet', () => {
    const parts = burst('a', 'b');
    useActivitySheetStore.getState().show(parts, burstView(parts, false), context);
    useActivitySheetStore.getState().close();
    expect(useActivitySheetStore.getState().sheet).toBeNull();
  });
});

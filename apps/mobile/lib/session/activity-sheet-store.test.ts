import { beforeEach, describe, expect, test } from 'bun:test';
import type { Part } from '@kortix/sdk';

import { burstView } from './activity';
import { useActivitySheetStore } from './activity-sheet-store';

function tool(id: string): Part {
  return {
    type: 'tool',
    id,
    callID: `call_${id}`,
    tool: 'bash',
    sessionID: 's',
    messageID: 'm',
    state: { status: 'completed', input: { command: id } },
  } as unknown as Part;
}

const context = { sessionId: 's', turnLive: false };

describe('activity sheet store', () => {
  beforeEach(() => useActivitySheetStore.getState().close());

  test('starts closed', () => {
    expect(useActivitySheetStore.getState().sheet).toBeNull();
  });

  test('show opens the sheet for a burst', () => {
    const parts = [tool('a'), tool('b')];
    useActivitySheetStore.getState().show(parts, burstView(parts, false), context);
    const { sheet } = useActivitySheetStore.getState();
    expect(sheet?.partIds).toEqual(['a', 'b']);
    expect(sheet?.callIds).toEqual(['call_a', 'call_b']);
    expect(sheet?.view.summary.total).toBe(2);
  });

  test('sync updates the sheet from a burst that shares a part, and remembers every call', () => {
    const { show, sync } = useActivitySheetStore.getState();
    const first = [tool('a'), tool('b')];
    show(first, burstView(first, true, true), context);
    // The pending call `a` left the burst; `c` arrived.
    const next = [tool('b'), tool('c')];
    sync(next, burstView(next, true, true), { ...context, turnLive: true });
    const { sheet } = useActivitySheetStore.getState();
    expect(sheet?.partIds).toEqual(['b', 'c']);
    expect(sheet?.callIds).toEqual(['call_a', 'call_b', 'call_c']);
    expect(sheet?.context.turnLive).toBe(true);
  });

  test('sync from another burst changes nothing', () => {
    const { show, sync } = useActivitySheetStore.getState();
    const open = [tool('a'), tool('b')];
    show(open, burstView(open, false), context);
    const before = useActivitySheetStore.getState().sheet;
    const other = [tool('x'), tool('y')];
    sync(other, burstView(other, false), context);
    expect(useActivitySheetStore.getState().sheet).toBe(before);
  });

  test('sync while closed does not open the sheet', () => {
    const parts = [tool('a'), tool('b')];
    useActivitySheetStore.getState().sync(parts, burstView(parts, false), context);
    expect(useActivitySheetStore.getState().sheet).toBeNull();
  });

  test('close clears the sheet', () => {
    const parts = [tool('a'), tool('b')];
    useActivitySheetStore.getState().show(parts, burstView(parts, false), context);
    useActivitySheetStore.getState().close();
    expect(useActivitySheetStore.getState().sheet).toBeNull();
  });
});

import { describe, expect, test } from 'bun:test';

import { autoOpenThread } from './space-auto-open';

const wide = { matchMedia: () => ({ matches: true }) } as unknown as Pick<Window, 'matchMedia'>;
const narrow = { matchMedia: () => ({ matches: false }) } as unknown as Pick<Window, 'matchMedia'>;
const focusIn = (insidePanel: boolean) =>
  ({ activeElement: { closest: (selector: string) => (insidePanel && selector === '[data-thread-panel]' ? {} : null) } }) as unknown as Pick<Document, 'activeElement'>;

describe('a message sent from a space chat opens its thread', () => {
  test('beside the chat: opened', () => {
    const opened: string[] = [];
    expect(autoOpenThread('t1', (id) => opened.push(id), wide, focusIn(false))).toBe(true);
    expect(opened).toEqual(['t1']);
  });

  test('a narrow window, where the panel would cover the chat: not opened', () => {
    const opened: string[] = [];
    expect(autoOpenThread('t1', (id) => opened.push(id), narrow, focusIn(false))).toBe(false);
    expect(opened).toEqual([]);
  });

  test("the person is typing in the open thread's reply box: not taken away", () => {
    const opened: string[] = [];
    expect(autoOpenThread('t1', (id) => opened.push(id), wide, focusIn(true))).toBe(false);
    expect(opened).toEqual([]);
  });
});

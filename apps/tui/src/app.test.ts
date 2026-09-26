import { describe, expect, test } from 'bun:test';

import type { Focus } from './app-keys.ts';
import { focusOrder, nextFocus } from './app.tsx';

describe('focusOrder', () => {
  test('the session route is sidebar → transcript → composer', () => {
    expect(focusOrder('session', true, false)).toEqual(['sidebar', 'transcript', 'composer']);
  });

  test('the terminal joins the ring only while its panel is open', () => {
    expect(focusOrder('session', true, true)).toEqual([
      'sidebar',
      'transcript',
      'composer',
      'terminal',
    ]);
  });

  test('a narrow terminal drops the sidebar from the ring', () => {
    expect(focusOrder('session', false, true)).toEqual(['transcript', 'composer', 'terminal']);
  });

  test('a secondary screen is one region, and has no terminal panel', () => {
    expect(focusOrder('files', true, true)).toEqual(['sidebar', 'screen']);
    expect(focusOrder('account', false, false)).toEqual(['screen']);
  });
});

describe('nextFocus', () => {
  const open = focusOrder('session', true, true);
  const closed = focusOrder('session', true, false);

  test('Tab walks the ring in SPEC §6 order and wraps', () => {
    let focus: Focus = 'sidebar';
    const walked: Focus[] = [];
    for (let index = 0; index < 5; index += 1) {
      focus = nextFocus(focus, open, 1);
      walked.push(focus);
    }
    expect(walked).toEqual(['transcript', 'composer', 'terminal', 'sidebar', 'transcript']);
  });

  test('Shift+Tab walks it backwards', () => {
    expect(nextFocus('sidebar', open, -1)).toBe('terminal');
    expect(nextFocus('transcript', open, -1)).toBe('sidebar');
  });

  test('with the terminal closed the ring skips it', () => {
    expect(nextFocus('composer', closed, 1)).toBe('sidebar');
    expect(nextFocus('composer', open, 1)).toBe('terminal');
  });

  test('a focus that is not in the ring lands on its first region', () => {
    // Closing the terminal while it had focus is exactly this case.
    expect(nextFocus('terminal', closed, 1)).toBe('sidebar');
    expect(nextFocus('screen', closed, 1)).toBe('sidebar');
  });
});

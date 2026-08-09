import { describe, expect, test } from 'bun:test';

import { MenuNavState } from './menu-nav-state';

describe('MenuNavState — hasRows tracks ROWS, never a bare "match is active" flag', () => {
  // This is the CRITICAL regression: `@nonexistentfile` or `/xyzzy` — a
  // trigger match that never resolves to any row — must NEVER report
  // hasRows(true). Fix round 1 shipped a version keyed off onStart/onExit
  // instead, which left the Enter-to-submit guard stuck "on" for a menu with
  // zero rows, silently turning Enter into a paragraph split instead of a
  // submit. `open()` alone (no `setRows` call at all, the same as a query
  // that never returns anything) must produce zero `true` notifications.
  test('opening with a query that never yields a row never reports hasRows(true)', () => {
    const calls: boolean[] = [];
    const nav = new MenuNavState<string>({ onHasRowsChange: (v) => calls.push(v) });

    nav.open('nonexistentfile');
    nav.setRows([]); // e.g. the file search resolved to nothing
    nav.setQuery('nonexistentfile2');
    nav.setRows([]);

    expect(calls).toEqual([]);
    expect(nav.getSelectedRow()).toBeUndefined();
  });

  test('rows arriving flips hasRows(true) exactly once, not once per setRows call', () => {
    const calls: boolean[] = [];
    const nav = new MenuNavState<string>({ onHasRowsChange: (v) => calls.push(v) });

    nav.open('foo');
    nav.setRows(['a', 'b']);
    nav.setRows(['a', 'b', 'c']); // still non-empty — no second `true`

    expect(calls).toEqual([true]);
  });

  test('rows going from some to none flips hasRows back to false', () => {
    const calls: boolean[] = [];
    const nav = new MenuNavState<string>({ onHasRowsChange: (v) => calls.push(v) });

    nav.open('foo');
    nav.setRows(['a']);
    nav.setRows([]);

    expect(calls).toEqual([true, false]);
  });

  // The other half of the CRITICAL fix: closing must force the flag off even
  // if the last known row list was non-empty — otherwise Escape (or the
  // trigger text no longer matching) leaves the guard stuck "on" forever,
  // since nothing else will ever call setRows([]) again for a menu that no
  // longer exists.
  test('close() forces hasRows(false) even when the last known rows were non-empty', () => {
    const calls: boolean[] = [];
    const nav = new MenuNavState<string>({ onHasRowsChange: (v) => calls.push(v) });

    nav.open('foo');
    nav.setRows(['a', 'b']);
    nav.close();

    expect(calls).toEqual([true, false]);
  });

  test('close() when rows were already empty does not re-fire false', () => {
    const calls: boolean[] = [];
    const nav = new MenuNavState<string>({ onHasRowsChange: (v) => calls.push(v) });

    nav.open('foo');
    nav.close();

    expect(calls).toEqual([]);
  });

  // Fix round 2, Open 2 — the latent re-arm race: a `setRows` call arriving
  // AFTER `close()` (e.g. a stale MentionMenuHost effect still in flight when
  // an outside-click/exit transaction lands) must not silently flip
  // `hasRows` back to `true` with no menu open. Deterministic, unlike the
  // real race — this drives the exact sequence by hand.
  test('a setRows(non-empty) call arriving AFTER close() does not re-arm hasRows', () => {
    const calls: boolean[] = [];
    const nav = new MenuNavState<string>({ onHasRowsChange: (v) => calls.push(v) });

    nav.open('foo');
    nav.close();
    nav.setRows(['a', 'b']); // arrives too late — the menu is already closed

    expect(calls).toEqual([]); // no stray `true`
    expect(nav.getRows()).toEqual([]);
    expect(nav.getSelectedRow()).toBeUndefined();
  });

  test('setRows before the first open() is also a no-op', () => {
    const calls: boolean[] = [];
    const nav = new MenuNavState<string>({ onHasRowsChange: (v) => calls.push(v) });

    nav.setRows(['a']);

    expect(calls).toEqual([]);
    expect(nav.getRows()).toEqual([]);
  });

  test('open() after a stray post-close setRows still starts clean', () => {
    const calls: boolean[] = [];
    const nav = new MenuNavState<string>({ onHasRowsChange: (v) => calls.push(v) });

    nav.open('foo');
    nav.close();
    nav.setRows(['stale']); // ignored — see the test above

    nav.open('bar');
    expect(nav.getRows()).toEqual([]);
    expect(calls).toEqual([]);

    nav.setRows(['fresh']);
    expect(calls).toEqual([true]);
    expect(nav.getSelectedRow()).toBe('fresh');
  });
});

describe('MenuNavState — selection index: reset on query change, clamp otherwise', () => {
  // IMPORTANT fix: arrow to row 5, type one more character (query changes),
  // press Enter — must accept row 0 of the NEW list, not row 5 of the old one.
  test('a query change resets the index to 0, even mid-navigation', () => {
    const nav = new MenuNavState<string>();
    nav.open('a');
    nav.setRows(['r0', 'r1', 'r2', 'r3', 'r4', 'r5']);
    nav.move(1);
    nav.move(1);
    nav.move(1);
    nav.move(1);
    nav.move(1);
    expect(nav.getSelectedIndex()).toBe(5);

    nav.setQuery('ab'); // the query actually changed
    nav.setRows(['x0', 'x1']); // a completely different list

    expect(nav.getSelectedIndex()).toBe(0);
    expect(nav.getSelectedRow()).toBe('x0');
  });

  test('the SAME query re-resolving (e.g. a debounced search completing) does NOT reset a mid-navigation index — it only clamps', () => {
    const nav = new MenuNavState<string>();
    nav.open('a');
    nav.setRows(['r0', 'r1', 'r2']);
    nav.move(1);
    nav.move(1);
    expect(nav.getSelectedIndex()).toBe(2);

    nav.setQuery('a'); // unchanged — same keystroke's query re-affirmed
    nav.setRows(['r0', 'r1', 'r2', 'r3']); // more results arrived later

    expect(nav.getSelectedIndex()).toBe(2);
    expect(nav.getSelectedRow()).toBe('r2');
  });

  test('a same-query row list that shrinks clamps the index instead of resetting it', () => {
    const nav = new MenuNavState<string>();
    nav.open('a');
    nav.setRows(['r0', 'r1', 'r2', 'r3']);
    nav.move(1);
    nav.move(1);
    nav.move(1);
    expect(nav.getSelectedIndex()).toBe(3);

    nav.setRows(['r0']); // list shrank under the same query

    expect(nav.getSelectedIndex()).toBe(0);
    expect(nav.getSelectedRow()).toBe('r0');
  });

  test('open() always starts at index 0 regardless of a previous session', () => {
    const nav = new MenuNavState<string>();
    nav.open('a');
    nav.setRows(['r0', 'r1']);
    nav.move(1);
    nav.close();

    nav.open('b');
    expect(nav.getSelectedIndex()).toBe(0);
  });
});

describe('MenuNavState — move()', () => {
  test('wraps at both ends via moveSelection', () => {
    const nav = new MenuNavState<string>();
    nav.open('a');
    nav.setRows(['r0', 'r1', 'r2']);

    nav.move(-1);
    expect(nav.getSelectedIndex()).toBe(2);

    nav.move(1);
    nav.move(1);
    expect(nav.getSelectedIndex()).toBe(1);
  });

  test('is a no-op with zero rows', () => {
    const nav = new MenuNavState<string>();
    nav.open('a');
    nav.move(1);
    expect(nav.getSelectedIndex()).toBe(0);
    expect(nav.getSelectedRow()).toBeUndefined();
  });
});

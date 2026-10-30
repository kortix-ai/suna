import { describe, expect, test } from 'bun:test';
import { shouldTypeOnChange, TYPE_SPEED_MS } from './typed-title-logic';

/**
 * A session title types when its VALUE CHANGES, never when it renders.
 *
 * That is the whole guard against the frequency cliff: a list of twenty rows
 * repaints on every scroll, sort and unrelated state change, and none of those
 * are a change to a title. If this ever answers `true` on a first render, a
 * cold page load types every row at once.
 */
const type = (previous: string | null, next: string, reduceMotion = false) =>
  shouldTypeOnChange({ previous, next, reduceMotion });

describe('shouldTypeOnChange', () => {
  test('the first render never types — the row is appearing, nothing changed', () => {
    expect(type(null, 'Refactor the auth guard')).toBe(false);
  });

  test('a row that arrives with a real title already set stays silent', () => {
    // Reload, scroll-back, another device's session syncing in. All first
    // renders, all instant.
    expect(type(null, 'Ship the billing fix')).toBe(false);
  });

  test('the placeholder giving way to the generated title types', () => {
    // The reported case: a new session reads "New session" until the agent
    // names it.
    expect(type('New session', 'Add rate limiting to /v1/projects')).toBe(true);
  });

  test('an unchanged title does not re-type on a re-render', () => {
    expect(type('New session', 'New session')).toBe(false);
  });

  test('a rename types too — any arriving title, not just the generated one', () => {
    expect(type('Add rate limiting', 'Rate limiting, v2')).toBe(true);
  });

  test('reduced motion takes the title instantly, without the animation', () => {
    // The value is already correct; typing is decoration over it, so removing
    // it costs no information. No fade substitute for that reason.
    expect(type('New session', 'Add rate limiting', true)).toBe(false);
  });

  test('reduced motion still does not type on first render', () => {
    expect(type(null, 'Add rate limiting', true)).toBe(false);
  });

  test('an empty incoming title never types', () => {
    // The animation would finish on an empty string and leave a cursor
    // blinking on a row with no text.
    expect(type('New session', '')).toBe(false);
  });

  test('going FROM empty to a real title types', () => {
    expect(type('', 'Add rate limiting')).toBe(true);
  });

  test('the speed is shared, so no surface can drift from the others', () => {
    expect(TYPE_SPEED_MS).toBe(36);
  });
});

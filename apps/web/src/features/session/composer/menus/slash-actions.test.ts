import { describe, expect, test } from 'bun:test';

import { SLASH_ACTIONS, filterSlashActions, controlToOpenFor } from './slash-actions';

describe('SLASH_ACTIONS', () => {
  test('every action has a unique id', () => {
    const ids = SLASH_ACTIONS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('every action has a label and a description for the card layout', () => {
    for (const action of SLASH_ACTIONS) {
      expect(action.label.length).toBeGreaterThan(0);
      expect(action.description.length).toBeGreaterThan(0);
    }
  });
});

describe('filterSlashActions', () => {
  test('matches on label', () => {
    expect(filterSlashActions(SLASH_ACTIONS, 'model').map((a) => a.id)).toContain('switch-model');
  });

  test('matches on description so a synonym still finds the action', () => {
    expect(filterSlashActions(SLASH_ACTIONS, 'thinking').map((a) => a.id)).toContain(
      'set-reasoning-effort',
    );
  });

  test('an empty query returns every action', () => {
    expect(filterSlashActions(SLASH_ACTIONS, '')).toHaveLength(SLASH_ACTIONS.length);
  });

  test('a non-matching query returns none', () => {
    expect(filterSlashActions(SLASH_ACTIONS, 'zzzzz')).toHaveLength(0);
  });
});

/**
 * Which `/` rows open the model popover, and where they land.
 *
 * The behaviour these pin spans three files — `composer.tsx` sets the state,
 * `composer-toolbar.tsx` threads it, `model-selector.tsx` consumes it — and
 * none of them is reachable from `bun test` (no DOM, `React.lazy` boundary).
 * This mapping is the one piece that can be asserted, so it is the one that
 * has to carry the intent.
 */
describe('controlToOpenFor', () => {
  test('switch-model opens the model picker', () => {
    expect(controlToOpenFor('switch-model')).toBe('model');
  });

  test('set-reasoning-effort opens the reasoning dropdown, NOT the model picker', () => {
    // These were one control until reasoning effort was pulled out of the
    // model popover into its own toolbar dropdown. If this ever returns
    // 'model' again, the `/` row reopens the picker that no longer contains
    // the thing it names.
    expect(controlToOpenFor('set-reasoning-effort')).toBe('reasoning');
  });

  test('every other action opens nothing', () => {
    for (const id of ['switch-agent', 'attach-file', 'start-voice', 'set-scope'] as const) {
      expect(controlToOpenFor(id)).toBeNull();
    }
  });

  test('every SLASH_ACTIONS id is covered — a new action cannot silently open a control', () => {
    const opens = SLASH_ACTIONS.filter((a) => controlToOpenFor(a.id) !== null).map(
      (a) => `${a.id}:${controlToOpenFor(a.id)}`,
    );
    expect(opens.sort()).toEqual(['set-reasoning-effort:reasoning', 'switch-model:model']);
  });
});

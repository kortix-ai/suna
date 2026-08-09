import { describe, expect, test } from 'bun:test';

import { SLASH_ACTIONS, filterSlashActions } from './slash-actions';

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

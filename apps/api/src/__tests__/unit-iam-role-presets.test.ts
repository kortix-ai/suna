import { describe, expect, test } from 'bun:test';

import {
  BUILTIN_BY_ID,
  BUILTIN_PRESETS,
  USER_PRESET_ACTIONS,
  validateActions,
} from '../accounts/iam/role-presets';
import { PROJECT_ACTIONS, VALID_ACTIONS } from '../iam/actions';

describe('built-in role presets', () => {
  test('exposes the 6 built-ins plus the read+run "User" tier', () => {
    const keys = BUILTIN_PRESETS.map((p) => p.key).sort();
    expect(keys).toEqual(['admin', 'editor', 'manager', 'member', 'owner', 'user', 'viewer']);
  });

  test('every preset action is a real action (no drift from actions.ts)', () => {
    for (const p of BUILTIN_PRESETS) {
      for (const a of p.actions) expect(VALID_ACTIONS.has(a)).toBe(true);
    }
  });

  test('BUILTIN_BY_ID keys on the synthetic builtin: id', () => {
    expect(BUILTIN_BY_ID.get('builtin:manager')?.key).toBe('manager');
    expect(BUILTIN_BY_ID.has('builtin:nope')).toBe(false);
  });

  test('User tier = read + run: has session start/exec/stop + trigger.fire, NOT write/config', () => {
    const set = new Set(USER_PRESET_ACTIONS);
    expect(set.has(PROJECT_ACTIONS.PROJECT_READ)).toBe(true);
    expect(set.has(PROJECT_ACTIONS.PROJECT_SESSION_START)).toBe(true);
    expect(set.has(PROJECT_ACTIONS.PROJECT_SESSION_EXEC)).toBe(true);
    expect(set.has(PROJECT_ACTIONS.PROJECT_TRIGGER_FIRE)).toBe(true);
    // read leaves yes…
    expect(set.has(PROJECT_ACTIONS.PROJECT_AGENT_READ)).toBe(true);
    // …but NO write/config/gitops/members/deploy
    expect(set.has(PROJECT_ACTIONS.PROJECT_WRITE)).toBe(false);
    expect(set.has(PROJECT_ACTIONS.PROJECT_AGENT_WRITE)).toBe(false);
    expect(set.has(PROJECT_ACTIONS.PROJECT_GITOPS_MERGE)).toBe(false);
    expect(set.has(PROJECT_ACTIONS.PROJECT_DEPLOY)).toBe(false);
    expect(set.has(PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE)).toBe(false);
  });
});

describe('validateActions', () => {
  test('accepts known actions and dedupes', () => {
    const r = validateActions([PROJECT_ACTIONS.PROJECT_READ, PROJECT_ACTIONS.PROJECT_READ, PROJECT_ACTIONS.PROJECT_AGENT_WRITE]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.actions).toEqual([PROJECT_ACTIONS.PROJECT_READ, PROJECT_ACTIONS.PROJECT_AGENT_WRITE]);
  });

  test('rejects an unknown / injected action string', () => {
    const r = validateActions([PROJECT_ACTIONS.PROJECT_READ, 'project.everything.hax']);
    expect(r.ok).toBe(false);
  });

  test('rejects a non-array', () => {
    expect(validateActions('project.read').ok).toBe(false);
    expect(validateActions(null).ok).toBe(false);
  });

  test('accepts an empty set (a role that grants nothing yet)', () => {
    const r = validateActions([]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.actions).toEqual([]);
  });
});

/**
 * Tool-call policy engine — glob match, first-match-wins, action resolution,
 * visibility (blocked tools hidden). Mirrors executor's model.
 */
import { describe, expect, test } from 'bun:test';
import {
  globToRegex,
  isVisible,
  matchesPolicy,
  resolvePolicyAction,
  type Policy,
} from '../executor/policy';

describe('matchesPolicy', () => {
  test('* matches everything', () => {
    expect(matchesPolicy('*', 'charges.create')).toBe(true);
  });
  test('exact', () => {
    expect(matchesPolicy('charges.create', 'charges.create')).toBe(true);
    expect(matchesPolicy('charges.create', 'charges.list')).toBe(false);
  });
  test('trailing wildcard', () => {
    expect(matchesPolicy('charges.*', 'charges.create')).toBe(true);
    expect(matchesPolicy('charges.*', 'refunds.create')).toBe(false);
  });
  test('mid/leading wildcard (e.g. *.delete*)', () => {
    expect(matchesPolicy('*.delete*', 'pets.deletePet')).toBe(true);
    expect(matchesPolicy('*.delete*', 'pets.getPet')).toBe(false);
  });
  test('case-insensitive', () => {
    expect(matchesPolicy('Charges.*', 'charges.create')).toBe(true);
  });
  test('globToRegex anchors', () => {
    expect(globToRegex('a.b').test('xa.by')).toBe(false);
  });
});

describe('resolvePolicyAction — first match wins, position order', () => {
  const policies: Policy[] = [
    { match: '*.delete*', action: 'block', position: 0 },
    { match: 'charges.create', action: 'require_approval', position: 1 },
    { match: '*', action: 'always_run', position: 2 },
  ];

  test('block wins for delete', () => {
    expect(resolvePolicyAction('pets.deletePet', policies)).toBe('block');
  });
  test('require_approval for the specific create', () => {
    expect(resolvePolicyAction('charges.create', policies)).toBe('require_approval');
  });
  test('catch-all always_run otherwise', () => {
    expect(resolvePolicyAction('charges.list', policies)).toBe('always_run');
  });
  test('no policies → always_run (allow-all default)', () => {
    expect(resolvePolicyAction('anything', [])).toBe('always_run');
  });
  test('position controls precedence regardless of array order', () => {
    const reordered: Policy[] = [
      { match: '*', action: 'always_run', position: 5 },
      { match: 'secret.*', action: 'block', position: 0 },
    ];
    expect(resolvePolicyAction('secret.read', reordered)).toBe('block');
  });
});

describe('isVisible', () => {
  test('blocked tools are hidden', () => {
    const policies: Policy[] = [{ match: 'admin.*', action: 'block' }];
    expect(isVisible('admin.reset', policies)).toBe(false);
    expect(isVisible('users.list', policies)).toBe(true);
  });
});

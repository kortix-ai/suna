import { describe, expect, test } from 'bun:test';
import { comparePatterns, orderPermissionRules } from '../permission-rules';

const keys = (value: unknown) => Object.keys(value as object);

describe('orderPermissionRules', () => {
  test.each([
    ['a trailing * moves first', { 'git push *': 'ask', '*': 'allow' }, ['*', 'git push *']],
    ['the prod skills shape: listed names after *', { 'aie-os': 'allow', '*': 'deny', 'customize-opencode': 'deny' }, ['*', 'aie-os', 'customize-opencode']],
    ['longer patterns sort later', { 'git *': 'ask', '*': 'deny', 'git push *': 'deny', 'git status': 'allow' }, ['*', 'git *', 'git push *', 'git status']],
    ['equal length sorts by code unit', { 'git a*': 'deny', 'git *b': 'allow' }, ['git *b', 'git a*']],
  ])('%s', (_name, map, expected) => {
    expect(keys(orderPermissionRules({ bash: map }).bash)).toEqual(expected);
  });

  test('permission keys are ordered too: `*` before the tool it covers', () => {
    expect(keys(orderPermissionRules({ bash: 'ask', '*': 'allow', pty_spawn: 'deny', 'pty_*': 'ask' }))).toEqual(['*', 'bash', 'pty_*', 'pty_spawn']);
  });

  test('a bare action, an array and nothing are returned unchanged', () => {
    expect(orderPermissionRules('allow')).toBe('allow');
    expect(orderPermissionRules(undefined)).toBeUndefined();
    expect(orderPermissionRules(['x'])).toEqual(['x']);
  });

  test('ordering is idempotent and keeps every rule', () => {
    const map = { webfetch: 'ask', skill: { b: 'allow', '*': 'deny', a: 'allow' }, '*': 'allow' };
    const once = orderPermissionRules(map);
    expect(orderPermissionRules(once)).toEqual(once);
    expect(once).toEqual(map);
  });

  test('comparePatterns: shorter first, then code unit', () => {
    expect(['ab', '*', 'b', 'a'].sort(comparePatterns)).toEqual(['*', 'a', 'b', 'ab']);
  });
});

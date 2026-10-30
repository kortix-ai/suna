import { describe, expect, test } from 'bun:test';
import { parseTriggerFilter, triggerFilterValueMatches } from './trigger-filter';

describe('parseTriggerFilter', () => {
  test('a scalar is equality, stored as a string', () => {
    expect(parseTriggerFilter({ 'body.type': 'push', 'body.count': 3, ' body.ok ': true })).toEqual({
      filter: { 'body.type': 'push', 'body.count': '3', 'body.ok': 'true' },
    });
  });

  test('each operator is stored in one shape: lists of strings, exists a boolean', () => {
    expect(
      parseTriggerFilter({
        'body.sender.login': { not: 'kortix-bot' },
        'body.action': { in: ['opened', 'reopened', 2] },
        'body.pull_request': { exists: true },
        'body.ref': { prefix: 'refs/heads/release/' },
        'body.head_ref': { not_prefix: ['kortix/', 'bot/'] },
      }),
    ).toEqual({
      filter: {
        'body.sender.login': { not: ['kortix-bot'] },
        'body.action': { in: ['opened', 'reopened', '2'] },
        'body.pull_request': { exists: true },
        'body.ref': { prefix: ['refs/heads/release/'] },
        'body.head_ref': { not_prefix: ['kortix/', 'bot/'] },
      },
    });
  });

  test('absent, null and empty mean no filter', () => {
    expect(parseTriggerFilter(undefined)).toEqual({ filter: null });
    expect(parseTriggerFilter(null)).toEqual({ filter: null });
    expect(parseTriggerFilter({})).toEqual({ filter: null });
  });

  test.each([
    ['a list', ['body.type'], 'filter must map payload paths to a value or one operator'],
    ['a blank path', { '  ': 'x' }, 'filter paths must not be blank'],
    ['null', { 'body.a': null }, 'filter.body.a must be a string, number, boolean, or one operator: not, in, exists, prefix, not_prefix'],
    ['a bare list', { 'body.a': ['x'] }, 'filter.body.a must be a string, number, boolean, or one operator: not, in, exists, prefix, not_prefix'],
    ['an unknown operator', { 'body.a': { nott: 'x' } }, 'filter.body.a has an unknown operator "nott"; use one of: not, in, exists, prefix, not_prefix'],
    ['two operators', { 'body.a': { in: ['x'], not: 'y' } }, 'filter.body.a takes one operator, got 2: in, not'],
    ['no operator', { 'body.a': {} }, 'filter.body.a takes one operator, got 0'],
    ['an empty list', { 'body.a': { in: [] } }, 'filter.body.a.in must list at least one value'],
    ['a nested object in a list', { 'body.a': { not: [{ x: 1 }] } }, 'filter.body.a.not values must be strings, numbers, or booleans'],
    ['an empty prefix', { 'body.a': { prefix: '' } }, 'filter.body.a.prefix values must not be empty'],
    ['a non-boolean exists', { 'body.a': { exists: 'yes' } }, 'filter.body.a.exists must be true or false'],
  ])('rejects %s', (_label, raw, error) => {
    expect(parseTriggerFilter(raw)).toEqual({ error });
  });
});

describe('triggerFilterValueMatches', () => {
  test('equality compares stringwise; a missing value does not match', () => {
    expect(triggerFilterValueMatches('push', 'push')).toBe(true);
    expect(triggerFilterValueMatches('3', 3)).toBe(true);
    expect(triggerFilterValueMatches('true', true)).toBe(true);
    expect(triggerFilterValueMatches('push', 'issues')).toBe(false);
    expect(triggerFilterValueMatches('push', undefined)).toBe(false);
  });

  test('in matches one listed value; a missing value does not match', () => {
    expect(triggerFilterValueMatches({ in: ['opened', 'reopened'] }, 'reopened')).toBe(true);
    expect(triggerFilterValueMatches({ in: ['opened', 'reopened'] }, 'closed')).toBe(false);
    expect(triggerFilterValueMatches({ in: ['opened'] }, undefined)).toBe(false);
  });

  test('not matches every value it does not list, and a missing value', () => {
    expect(triggerFilterValueMatches({ not: ['kortix-bot'] }, 'a-person')).toBe(true);
    expect(triggerFilterValueMatches({ not: ['kortix-bot'] }, 'kortix-bot')).toBe(false);
    expect(triggerFilterValueMatches({ not: ['kortix-bot', 'other-bot'] }, 'other-bot')).toBe(false);
    expect(triggerFilterValueMatches({ not: ['kortix-bot'] }, undefined)).toBe(true);
  });

  test('exists: null and missing are absent; any other value, empty string included, is present', () => {
    expect(triggerFilterValueMatches({ exists: true }, { number: 1 })).toBe(true);
    expect(triggerFilterValueMatches({ exists: true }, '')).toBe(true);
    expect(triggerFilterValueMatches({ exists: true }, null)).toBe(false);
    expect(triggerFilterValueMatches({ exists: true }, undefined)).toBe(false);
    expect(triggerFilterValueMatches({ exists: false }, undefined)).toBe(true);
    expect(triggerFilterValueMatches({ exists: false }, 0)).toBe(false);
  });

  test('prefix matches a value that starts with one listed prefix; a missing value does not match', () => {
    expect(triggerFilterValueMatches({ prefix: ['refs/heads/release/'] }, 'refs/heads/release/1.2')).toBe(true);
    expect(triggerFilterValueMatches({ prefix: ['refs/heads/release/'] }, 'refs/heads/main')).toBe(false);
    expect(triggerFilterValueMatches({ prefix: ['x'] }, undefined)).toBe(false);
  });

  test('not_prefix matches a value that starts with no listed prefix, and a missing value', () => {
    expect(triggerFilterValueMatches({ not_prefix: ['refs/heads/kortix/'] }, 'refs/heads/main')).toBe(true);
    expect(triggerFilterValueMatches({ not_prefix: ['refs/heads/kortix/'] }, 'refs/heads/kortix/fix-lint')).toBe(false);
    expect(triggerFilterValueMatches({ not_prefix: ['refs/heads/kortix/'] }, undefined)).toBe(true);
  });

  test('an object or list value compares as its JSON text', () => {
    expect(triggerFilterValueMatches('{"a":1}', { a: 1 })).toBe(true);
    expect(triggerFilterValueMatches({ prefix: ['['] }, [1, 2])).toBe(true);
  });
});

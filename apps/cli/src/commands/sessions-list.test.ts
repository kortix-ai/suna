import { describe, expect, test } from 'bun:test';
import type { ProjectSession } from '../api/types.ts';
import { sessionListQuery, startedByLabel, takeSessionListFlags } from './sessions-list.ts';

const row = (initiator: ProjectSession['initiator']) => ({ initiator }) as ProjectSession;

describe('takeSessionListFlags', () => {
  test('defaults to no filter', () => {
    expect(takeSessionListFlags([])).toEqual({ startedBy: undefined, search: undefined, children: undefined });
  });
  test('maps --mine/--shared/--automated', () => {
    expect(takeSessionListFlags(['--mine']).startedBy).toBe('me');
    expect(takeSessionListFlags(['--shared']).startedBy).toBe('others');
    expect(takeSessionListFlags(['--automated']).startedBy).toBe('automated');
  });
  test('rejects two starter filters', () => {
    expect(() => takeSessionListFlags(['--mine', '--shared'])).toThrow('only one of');
  });
  test('trims --search and bounds it', () => {
    expect(takeSessionListFlags(['--search', '  deploy ']).search).toBe('deploy');
    expect(() => takeSessionListFlags(['--search', 'x'.repeat(201)])).toThrow('1 to 200');
    expect(() => takeSessionListFlags(['--search'])).toThrow('requires a value');
  });
  test('--children excludes a starter filter', () => {
    expect(() => takeSessionListFlags(['--children', 'abc', '--mine'])).toThrow('cannot be combined');
  });
});

describe('sessionListQuery', () => {
  test('default is the unchanged flat list', () => {
    expect(sessionListQuery(takeSessionListFlags([]))).toBe('');
  });
  test('--search alone searches every level', () => {
    expect(sessionListQuery(takeSessionListFlags(['--search', 'rent']))).toBe('?q=rent');
  });
  test('filters + search', () => {
    expect(sessionListQuery(takeSessionListFlags(['--automated', '--search', 'a b']))).toBe(
      '?parent=root&started_by=automated&q=a+b',
    );
  });
  test('children of one parent', () => {
    expect(sessionListQuery(takeSessionListFlags(['--children', 'x']), 'parent-id')).toBe('?parent=parent-id');
  });
});

describe('startedByLabel', () => {
  test('viewer -> you, others -> label, none -> dash', () => {
    expect(startedByLabel(row({ type: 'member', id: 'u1', label: 'Ada' }), 'u1')).toBe('you');
    expect(startedByLabel(row({ type: 'member', id: 'u2', label: 'Bob' }), 'u1')).toBe('Bob');
    expect(startedByLabel(row({ type: 'trigger', id: 'u1', label: 'nightly' }), 'u1')).toBe('nightly');
    expect(startedByLabel(row(null), 'u1')).toBe('-');
  });
});

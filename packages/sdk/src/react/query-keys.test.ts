import { describe, expect, test } from 'bun:test';
import { qk } from './query-keys';

const startsWith = (key: readonly unknown[], prefix: readonly unknown[]) =>
  prefix.every((segment, i) => key[i] === segment);

describe('qk.project', () => {
  const id = 'proj_123';

  // `scope(id)` is the invalidation prefix. Every project-scoped key must sit
  // under it, or `invalidateQueries({ queryKey: qk.project.scope(id) })`
  // silently misses whatever escaped.
  test('every project-scoped key is prefixed by scope', () => {
    const scope = qk.project.scope(id);
    const scoped = [
      qk.project.detail(id),
      qk.project.sessions(id),
      qk.project.session(id, 'sess_1'),
      qk.project.messages(id, 'sess_1'),
      qk.project.connectors(id),
      qk.project.access(id),
      qk.project.secrets(id),
      qk.project.files(id),
      qk.project.branches(id),
      qk.project.policies(id),
      qk.project.config(id),
      qk.project.sandboxes(id),
      qk.project.snapshots(id),
      qk.project.gateway(id),
    ];
    for (const key of scoped) {
      expect(startsWith(key, scope)).toBe(true);
    }
  });

  // scope() is a prefix, never a query key. If it equals a real key, then
  // invalidating the subtree also refetches a query nobody declared.
  test('scope is a strict prefix, never a key itself', () => {
    const scope = qk.project.scope(id);
    expect(qk.project.detail(id).length).toBeGreaterThan(scope.length);
    expect(qk.project.detail(id)).not.toEqual(scope as never);
  });

  test('session keys nest under sessions so one session invalidates alone', () => {
    expect(startsWith(qk.project.session(id, 's1'), qk.project.sessions(id))).toBe(true);
    expect(startsWith(qk.project.messages(id, 's1'), qk.project.session(id, 's1'))).toBe(true);
  });

  test('different projects never collide', () => {
    expect(qk.project.detail('a')).not.toEqual(qk.project.detail('b') as never);
  });

  test('the projects list is not under any project scope', () => {
    expect(startsWith(qk.projects.list(), qk.project.scope(id))).toBe(false);
  });

  test('the projects list partitions by account', () => {
    expect(qk.projects.list('acct_1')).not.toEqual(qk.projects.list('acct_2') as never);
    expect(qk.projects.list()).toEqual(qk.projects.list(undefined));
  });
});

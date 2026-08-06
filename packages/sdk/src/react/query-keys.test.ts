import { describe, expect, test } from 'bun:test';
import { qk } from './query-keys';
import { kortixKeys } from './use-kortix-master';

const startsWith = (key: readonly unknown[], prefix: readonly unknown[]) =>
  prefix.every((segment, i) => key[i] === segment);

// `kortixKeys` (use-kortix-master.ts) addresses the multi-server Kortix
// Master surface. `qk` addresses the platform project surface. Both used to
// root at `'kortix'`, so `kortixKeys.project(id)` and `qk.projects.list(id)`
// were the same array for a matching id, and `kortixKeys.projects()` — used
// as an `invalidateQueries` prefix — would prefix-match every `qk` key too.
// `qk` now roots at `'kx'`; this test fails immediately if that ever drifts
// back to `'kortix'`.
describe('qk vs kortixKeys — disjoint key spaces', () => {
  const id = 'p1';

  const qkKeys: Record<string, readonly unknown[]> = {
    'qk.projects.list()': qk.projects.list(),
    "qk.projects.list('acct_1')": qk.projects.list('acct_1'),
    // Same id as `kortixKeys.project(id)` below — this is the exact pair that
    // collided when both factories rooted at `'kortix'`:
    // `['kortix', 'projects', id]` for both.
    'qk.projects.list(id)': qk.projects.list(id),
    'qk.project.scope(id)': qk.project.scope(id),
    'qk.project.detail(id)': qk.project.detail(id),
  };

  const kortixMasterKeys: Record<string, readonly unknown[]> = {
    'kortixKeys.projects()': kortixKeys.projects(),
    'kortixKeys.project(id)': kortixKeys.project(id),
  };

  for (const [qkName, qkKey] of Object.entries(qkKeys)) {
    for (const [kmName, kmKey] of Object.entries(kortixMasterKeys)) {
      test(`${kmName} is not a prefix of ${qkName}`, () => {
        expect(startsWith(qkKey, kmKey)).toBe(false);
      });

      test(`${qkName} is not a prefix of ${kmName}`, () => {
        expect(startsWith(kmKey, qkKey)).toBe(false);
      });
    }
  }

  // The exact collision from the review finding, asserted directly and by
  // name rather than only via the parameterized loop above: with a matching
  // id and a `'kortix'` root, these two would be the identical array.
  test('qk.projects.list(id) never equals kortixKeys.project(id) for the same id', () => {
    expect(qk.projects.list(id)).not.toEqual(kortixKeys.project(id) as never);
  });
});

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

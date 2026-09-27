// The object-grant memo must not cache an EMPTY map for an object type whose
// first grant can still be written later: `agent` (closed by unscoped
// default — a stale empty map reads as "still closed") and `connection`
// (open by unscoped default but narrowable since
// 20260926172248000_share_access_project_principal.sql — a stale empty map
// after the FIRST narrowing grant reads as "still open to everyone", a stale
// over-grant, not a harmless stale negative). Invalidation is per-process, so
// a sibling replica that has not seen the write serves the cached value for
// one TTL (observed on dev 2026-08-19 for `agent`; observed on the v0.13.34
// release gate, CONN-28, for `connection` — a group member's own `GET
// /connections` immediately after the owner's grant answered `shared_with:[]`
// on a replica that had not yet re-queried). Types with no per-object grant
// writer today (skill/secret/app/trigger) keep caching the empty map — it can
// never go stale. Source pin, because the memo's `enableInTests` is off by
// design and the rule is one line.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ttlMemo } from '../shared/ttl-memo';

const source = readFileSync(join(import.meta.dir, '../iam/authorize.ts'), 'utf8');
const flat = source.replace(/\s+/g, ' ');

describe('loadObjectGrants memo — empty map caching', () => {
  test('never caches an empty map for a closed-by-default or narrowable-by-default object type', () => {
    expect(flat).toContain(
      "shouldCache: (map, _projectId, objectType) => map.size > 0 || !NEVER_CACHE_EMPTY_OBJECT_TYPES.has(objectType)",
    );
    expect(flat).toContain(
      "NEVER_CACHE_EMPTY_OBJECT_TYPES: ReadonlySet<string> = new Set(['agent', 'connection'])",
    );
  });

  test('the unconditional cache-everything rule is gone', () => {
    const memo = flat.slice(flat.indexOf('const loadObjectGrants = ttlMemo('), flat.indexOf('registerProjectScopedMemo(loadObjectGrants)'));
    expect(memo).not.toContain('shouldCache: () => true');
  });
});

// CONN-28 (v0.13.34 release gate): a group grant on a project-owned connector
// account narrowed it correctly, but a group member's `GET /connections`
// still answered `shared_with:[]` — the narrowing was invisible on a replica
// whose `loadObjectGrants('connection')` had cached the pre-grant EMPTY map.
// Each replica is an independent in-process cache (no cross-replica bus), so
// this models two replicas as two `ttlMemo` instances over one shared "table".
describe('loadObjectGrants — cross-replica staleness for connection', () => {
  const NEVER_CACHE_EMPTY = new Set(['agent', 'connection']);

  function makeReplica(table: Map<string, string[]>) {
    let loads = 0;
    const memo = ttlMemo({
      ttlMs: 60_000,
      keyFn: (projectId: string, objectType: string) => `${projectId}|${objectType}`,
      loader: async (projectId: string, objectType: string) => {
        loads += 1;
        return new Map(table.entries());
      },
      shouldCache: (map, _projectId, objectType) => map.size > 0 || !NEVER_CACHE_EMPTY.has(objectType),
      enableInTests: true,
    });
    return { memo, get loads() { return loads; } };
  }

  test('a replica that cached the pre-grant empty map re-queries after a sibling writes the first grant', async () => {
    const table = new Map<string, string[]>();
    const replicaA = makeReplica(table); // reads before the grant exists
    const replicaB = makeReplica(table); // writes the grant

    // Replica A observes "no grants yet" and (per the fix) must NOT cache it.
    expect((await replicaA.memo('p1', 'connection')).size).toBe(0);

    // The grant is written directly to the shared table — replica B's own
    // cache bust is out of scope here; what matters is replica A's NEXT read.
    table.set('conn1', ['group:sales']);

    const afterGrant = await replicaA.memo('p1', 'connection');
    expect(afterGrant.size).toBe(1);
    expect(afterGrant.get('conn1')).toEqual(['group:sales']);
    expect(replicaA.loads).toBe(2); // re-queried, not served from a cached empty map
  });

  test('an agent (closed-by-default) gets the same protection', async () => {
    const table = new Map<string, string[]>();
    const replica = makeReplica(table);
    expect((await replica.memo('p1', 'agent')).size).toBe(0);
    table.set('agent1', ['user:u1']);
    expect((await replica.memo('p1', 'agent')).size).toBe(1);
    expect(replica.loads).toBe(2);
  });

  test('a type with no per-object grant writer today keeps caching the empty map', async () => {
    const table = new Map<string, string[]>();
    const replica = makeReplica(table);
    expect((await replica.memo('p1', 'skill')).size).toBe(0);
    table.set('skill1', ['user:u1']); // nothing writes this in production today
    expect((await replica.memo('p1', 'skill')).size).toBe(0); // served from cache, unchanged
    expect(replica.loads).toBe(1);
  });
});

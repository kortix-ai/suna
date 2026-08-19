// The object-grant memo must not cache an EMPTY map for a closed-by-default
// object type (agent). Invalidation is per-process; a stale empty map on a
// sibling replica reads as "still closed" and denies a member who was just
// granted an agent for one TTL (observed on dev 2026-08-19). Open-by-default
// types keep caching the empty map — a stale empty map there is "still open",
// which is what the caller already had. Source pin, because the memo's
// `enableInTests` is off by design and the rule is one line.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, '../iam/authorize.ts'), 'utf8');
const flat = source.replace(/\s+/g, ' ');

describe('loadObjectGrants memo — empty map caching', () => {
  test('never caches an empty map for a closed-by-default object type', () => {
    expect(flat).toContain(
      "shouldCache: (map, _projectId, objectType) => map.size > 0 || !CLOSED_BY_DEFAULT_OBJECT_TYPES.has(objectType)",
    );
    expect(flat).toContain("CLOSED_BY_DEFAULT_OBJECT_TYPES: ReadonlySet<string> = new Set(['agent'])");
  });

  test('the unconditional cache-everything rule is gone', () => {
    const memo = flat.slice(flat.indexOf('const loadObjectGrants = ttlMemo('), flat.indexOf('registerProjectScopedMemo(loadObjectGrants)'));
    expect(memo).not.toContain('shouldCache: () => true');
  });
});

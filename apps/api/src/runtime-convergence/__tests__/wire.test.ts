/**
 * `toRuntimeBlockWire` — the `runtime` block of `GET /config` (spec §3). Wire
 * shape only: strips the box's raw `components` map (already folded into the
 * per-field `components` list) so the same five fields the desired document
 * carries are what `actual` carries too.
 */
import { describe, expect, test } from 'bun:test';
import { toRuntimeBlockWire } from '../wire';
import { diffRuntime } from '../diff';
import { UNREPORTED_ACTUAL_RUNTIME } from '../actual';
import type { DesiredRuntimeDocument } from '../desired';

const DESIRED: DesiredRuntimeDocument = {
  release_id: 'rel_current',
  catalog_fingerprint: 'cat_current',
  daemon_build: 42,
  cli_sha256: 'c'.repeat(64),
  managed_skills_hash: 'm'.repeat(64),
};

describe('toRuntimeBlockWire', () => {
  test('serializes overall, desired, actual (flat, no raw components map), and the per-field list', () => {
    const diff = diffRuntime(DESIRED, {
      ...UNREPORTED_ACTUAL_RUNTIME,
      ...DESIRED,
      components: { release_id: { state: 'current', attempted_at: 't', attempts: 1, cause: null } },
    });
    const wire = toRuntimeBlockWire(diff);
    expect(wire.overall).toBe('current');
    expect(wire.desired).toEqual(DESIRED);
    expect(wire.actual).toEqual(DESIRED);
    expect((wire.actual as unknown as Record<string, unknown>).components).toBeUndefined();
    expect(wire.components).toHaveLength(5);
    const release = wire.components.find((c) => c.name === 'release_id');
    expect(release?.state).toBe('current');
    expect(release?.attempted_at).toBe('t');
  });
});

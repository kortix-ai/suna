import { describe, expect, test } from 'bun:test';
import {
  buildSandboxInitFailureMetadata,
  buildSandboxInitSuccessMetadata,
  sandboxInitMetadataPatch,
} from './sandbox-init-state';

/** Apply a patch the way the SQL does: strip, then merge, onto the LOCKED row. */
function apply(
  row: Record<string, unknown>,
  patch: { strip: string[]; merge: Record<string, unknown> },
): Record<string, unknown> {
  const next = { ...row };
  for (const key of patch.strip) delete next[key];
  return { ...next, ...patch.merge };
}

describe('sandboxInitMetadataPatch', () => {
  const snapshot = {
    initStatus: 'retrying',
    initStartedAt: '2026-09-25T10:00:00.000Z',
    lastInitError: 'first attempt failed',
    provisioningError: 'first attempt failed',
  };

  test('applied to the snapshot, it produces exactly what the builder built', () => {
    const built = buildSandboxInitSuccessMetadata(snapshot, { providerExternalId: 'box-1' }, 2);
    expect(apply(snapshot, sandboxInitMetadataPatch(snapshot, built))).toEqual(built);
  });

  test('a key another writer added after the snapshot survives', () => {
    const built = buildSandboxInitFailureMetadata(snapshot, new Error('boom'), 3, false);
    const locked = { ...snapshot, egressPinnedIp: '203.0.113.7' };
    const after = apply(locked, sandboxInitMetadataPatch(snapshot, built));
    expect(after.egressPinnedIp).toBe('203.0.113.7');
    expect(after.initStatus).toBe('failed');
    expect(after.lastInitError).toBe('boom');
  });

  test('merges only what changed, and strips the failure keys the builder dropped', () => {
    const built = buildSandboxInitSuccessMetadata(snapshot, {}, 2);
    const patch = sandboxInitMetadataPatch(snapshot, built);
    expect(patch.merge).not.toHaveProperty('initStartedAt');
    expect(patch.strip).toContain('provisioningError');
    // The builder rewrites `lastInitError` (to null): it is merged, not stripped.
    expect(patch.strip).not.toContain('lastInitError');
    expect(patch.merge.lastInitError).toBeNull();
  });
});

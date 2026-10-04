/**
 * `computeDesiredRuntime` — the one desired-runtime document (Rule 1). It must
 * not compute any of its five values itself: it composes the SAME sources of
 * truth `services/config-releases/desired.ts` and `services/runtime-assets/manifest.ts` already
 * serve, plus one new fingerprint over the served managed lineup. This test
 * asserts the composition, injecting fakes for every source so it never
 * touches a real manifest (which hashes ~200 MB of binary) or the DB.
 */
import { describe, expect, test } from 'bun:test';
import { computeDesiredRuntime } from '../desired';

describe('computeDesiredRuntime', () => {
  test('composes release id, catalog fingerprint and the three asset values — no second opinion', async () => {
    const doc = await computeDesiredRuntime(
      { releaseId: 'rel_current' },
      {
        manifest: async () => ({
          build: 42,
          cli_sha256: 'c'.repeat(64),
          managed_skills_hash: 'm'.repeat(64),
        }),
        catalogFingerprint: () => 'cat_fingerprint_1',
      },
    );
    expect(doc).toEqual({
      release_id: 'rel_current',
      catalog_fingerprint: 'cat_fingerprint_1',
      daemon_build: 42,
      cli_sha256: 'c'.repeat(64),
      managed_skills_hash: 'm'.repeat(64),
    });
  });

  test('a null release id (base ref unresolved, or the flag is off) is carried through as null', async () => {
    const doc = await computeDesiredRuntime(
      { releaseId: null },
      {
        manifest: async () => ({ build: 1, cli_sha256: null, managed_skills_hash: 'm'.repeat(64) }),
        catalogFingerprint: () => 'cat_fingerprint_1',
      },
    );
    expect(doc.release_id).toBeNull();
    expect(doc.cli_sha256).toBeNull();
  });
});

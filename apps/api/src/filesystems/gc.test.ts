import { describe, expect, test } from 'bun:test';
import { DEFAULT_BLOB_GRACE_MS, selectCollectableBlobs } from './gc';

const NOW = new Date('2026-09-02T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);

describe('which blobs are safe to collect', () => {
  test('a blob no path references, older than the grace period, is collectable', () => {
    const out = selectCollectableBlobs({
      blobs: [{ sha256: 'orphan', createdAt: ago(DEFAULT_BLOB_GRACE_MS + 1000) }],
      referenced: new Set(),
      now: NOW,
    });
    expect(out).toEqual(['orphan']);
  });

  test('a referenced blob is NEVER collectable, however old', () => {
    const out = selectCollectableBlobs({
      blobs: [{ sha256: 'live', createdAt: ago(365 * 24 * 3600_000) }],
      referenced: new Set(['live']),
      now: NOW,
    });
    expect(out).toEqual([]);
  });

  /**
   * THE SAFETY RULE. `putFile` stores the bytes and THEN inserts the metadata
   * row, so between those two statements a blob is legitimately unreferenced.
   * Collecting on "unreferenced" alone would delete the bytes of a file that
   * is in the middle of being written, and the write would report success.
   */
  test('a young unreferenced blob is spared — it may be a write in flight', () => {
    const out = selectCollectableBlobs({
      blobs: [{ sha256: 'inflight', createdAt: ago(5_000) }],
      referenced: new Set(),
      now: NOW,
    });
    expect(out).toEqual([]);
  });

  test('the grace boundary is exclusive on the young side', () => {
    const exactly = selectCollectableBlobs({
      blobs: [{ sha256: 'edge', createdAt: ago(DEFAULT_BLOB_GRACE_MS) }],
      referenced: new Set(),
      now: NOW,
    });
    // Exactly at the boundary is not yet older than it.
    expect(exactly).toEqual([]);
  });

  test('content addressing means one live path protects every copy', () => {
    // Twenty paths wrote identical bytes; nineteen were deleted. The blob is
    // still referenced by the twentieth and must survive.
    const out = selectCollectableBlobs({
      blobs: [{ sha256: 'shared', createdAt: ago(DEFAULT_BLOB_GRACE_MS * 10) }],
      referenced: new Set(['shared']),
      now: NOW,
    });
    expect(out).toEqual([]);
  });

  test('a caller may widen the grace period but the default is generous', () => {
    const blobs = [{ sha256: 'x', createdAt: ago(2 * 3600_000) }];
    expect(selectCollectableBlobs({ blobs, referenced: new Set(), now: NOW })).toEqual(['x']);
    expect(
      selectCollectableBlobs({ blobs, referenced: new Set(), now: NOW, graceMs: 24 * 3600_000 }),
    ).toEqual([]);
    // An hour is long enough that no single write is still in flight.
    expect(DEFAULT_BLOB_GRACE_MS).toBeGreaterThanOrEqual(3600_000);
  });

  test('mixed input returns only the collectable ones, order preserved', () => {
    const out = selectCollectableBlobs({
      blobs: [
        { sha256: 'old-orphan', createdAt: ago(DEFAULT_BLOB_GRACE_MS * 2) },
        { sha256: 'old-live', createdAt: ago(DEFAULT_BLOB_GRACE_MS * 2) },
        { sha256: 'young-orphan', createdAt: ago(1_000) },
        { sha256: 'another-orphan', createdAt: ago(DEFAULT_BLOB_GRACE_MS * 3) },
      ],
      referenced: new Set(['old-live']),
      now: NOW,
    });
    expect(out).toEqual(['old-orphan', 'another-orphan']);
  });
});

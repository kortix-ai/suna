import { describe, expect, it } from 'bun:test';
import { DEFAULT_MAX_REQUEST_BYTES } from './config';

describe('DEFAULT_MAX_REQUEST_BYTES', () => {
  it('is high enough that real multimodal (image-heavy) agent turns never 413', () => {
    // Regression guard: the gateway must not be what rejects a large-but-legit
    // request. Self-host measured 9-12 MiB turns 413'd at the old 8 MiB ceiling;
    // image-heavy turns run larger still. Keep the default far above that so the
    // upstream — not the gateway — enforces any real size limit.
    expect(DEFAULT_MAX_REQUEST_BYTES).toBeGreaterThanOrEqual(1024 * 1024 * 1024);
  });
});

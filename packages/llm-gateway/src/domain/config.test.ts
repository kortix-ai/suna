import { describe, expect, it } from 'bun:test';
import { DEFAULT_MAX_REQUEST_BYTES } from './config';

// This ceiling is squeezed from BOTH sides, and the old guard only checked one
// of them. Too low and the gateway 413s a legitimate image-heavy turn; too high
// and it is not a limit at all, just a number that permits a single request to
// consume every byte the process has.
describe('DEFAULT_MAX_REQUEST_BYTES', () => {
  const MiB = 1024 * 1024;

  it('is high enough that real multimodal (image-heavy) agent turns never 413', () => {
    // Self-host measured 9-12 MiB turns 413'ing at an old 8 MiB ceiling, and
    // image-heavy turns run larger still. Keep a wide margin over the largest
    // turn ever observed.
    const LARGEST_MEASURED_TURN = 12 * MiB;
    expect(DEFAULT_MAX_REQUEST_BYTES).toBeGreaterThanOrEqual(LARGEST_MEASURED_TURN * 4);
  });

  it('is a FRACTION of the memory the smallest deployed container has', () => {
    // The missing half of the old guard. This was 1 GiB — larger than the
    // 1024 MiB dev task and the 640 MiB self-host container it was supposed to
    // protect, so a single "permitted" request could exceed all the memory
    // there was. On 2026-08-21 the dev API was OOM-killed three times in eleven
    // minutes and browsers got Cloudflare's "Bad Gateway" page.
    //
    // A backstop larger than the thing it protects is decoration. The gateway
    // holds several derived copies of a body in flight (the UTF-16 string, the
    // JSON.parse graph), so the ceiling must leave room for all of them plus
    // concurrent requests.
    const SMALLEST_DEPLOYED_CONTAINER = 640 * MiB;
    expect(DEFAULT_MAX_REQUEST_BYTES).toBeLessThan(SMALLEST_DEPLOYED_CONTAINER / 4);
  });
});

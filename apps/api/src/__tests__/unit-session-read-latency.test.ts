import { describe, expect, test } from 'bun:test';

describe('session read latency boundary', () => {
  test('session list and detail routes do not contact sandbox runtimes', async () => {
    const source = await Bun.file(new URL('../projects/routes/r7.ts', import.meta.url)).text();
    // Read routes must never trigger an opencode_sessions snapshot sync (a
    // per-sandbox round-trip); that only happens deferred off the prompt path.
    expect(source).not.toContain('syncOpencodeSessionSnapshot');
    expect(source).not.toContain('scheduleOpencodeSnapshotSync');
  });
});

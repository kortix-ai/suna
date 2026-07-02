// Regression coverage for the 2026-07-02 incident: bare `fetch()` has no
// default timeout, so a stalled Platinum connection hung the caller
// indefinitely — the same failure class as the Daytona SDK's 24h axios
// default (see platform/providers/daytona.ts). Platinum is dev's default
// sandbox provider and getStatus()/stop()/start() sit on the reaper hot
// path, so an unbounded hang there wedges the maintenance loop forever
// (maintenance.ts's `finally` never runs). This spins up a real local server
// that never responds, to prove platinumJson() actually gives up instead of
// hanging on a genuinely stalled connection.
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';

let mockPlatinumApiKey = 'pt_test_key';
let mockPlatinumApiUrl = '';

// Real config.ts validates the actual dotenvx-encrypted process.env and
// exits on a bare `bun test` run (see sandbox-reaper.test.ts for the same
// pattern) — platinum.ts only reads these two fields, so mock just those.
mock.module('../config', () => ({
  get config() {
    return { PLATINUM_API_KEY: mockPlatinumApiKey, PLATINUM_API_URL: mockPlatinumApiUrl };
  },
}));

let server: ReturnType<typeof Bun.serve> | null = null;

beforeEach(() => {
  // Below the code's own 1000ms floor (Math.max(1000, …)) would just get
  // clamped up — use a value comfortably above it so this actually exercises
  // the configured override, not the floor.
  process.env.KORTIX_PLATINUM_CALL_TIMEOUT_MS = '1500';
  mockPlatinumApiKey = 'pt_test_key';
});

afterEach(() => {
  server?.stop(true);
  server = null;
  delete process.env.KORTIX_PLATINUM_CALL_TIMEOUT_MS;
});

test('platinumJson gives up on a stalled connection instead of hanging forever', async () => {
  // Accepts the connection but never resolves the handler — simulates a
  // Daytona/Platinum-style network stall, not a fast error response.
  server = Bun.serve({
    port: 0,
    fetch: () => new Promise<Response>(() => {}),
  });
  mockPlatinumApiUrl = `http://localhost:${server.port}`;

  const { platinumJson } = await import('./platinum');

  const start = Date.now();
  await expect(platinumJson('/v1/sandboxes/sb_test')).rejects.toThrow(/timed out after 1500ms/);
  const elapsed = Date.now() - start;
  // Bounded well under a real hang (which would be the SDK's own 24h-class
  // default) — generous margin for CI jitter, still proves it didn't hang.
  expect(elapsed).toBeLessThan(6_000);
});

test('platinumJson respects an explicit caller-provided signal instead of the default', async () => {
  server = Bun.serve({
    port: 0,
    fetch: () => new Promise<Response>(() => {}),
  });
  mockPlatinumApiUrl = `http://localhost:${server.port}`;

  const { platinumJson } = await import('./platinum');

  const start = Date.now();
  // Explicit signal shorter than the (irrelevant here) default — proves the
  // default doesn't clobber a caller's own budget (e.g. create()'s 70s bound
  // for Platinum's own 60s server-side wait_timeout_ms long-poll).
  await expect(
    platinumJson('/v1/sandboxes/sb_test', { signal: AbortSignal.timeout(50) }),
  ).rejects.toThrow();
  const elapsed = Date.now() - start;
  expect(elapsed).toBeLessThan(2_000);
});

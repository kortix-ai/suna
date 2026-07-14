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

// Platinum auto-stops idle microVMs natively; while a box is stopped, POST
// /:id/expose answers `409 {"code":"sandbox_not_running"}`. That is an EXPECTED
// state — the caller wakes+retries or surfaces a retryable 503 — and must NOT
// page Sentry. So platinumJson classifies it into a typed
// PlatinumSandboxNotRunningError, while every OTHER non-2xx stays a generic
// Error (captured normally). Regression for Better Stack error
// ea98adefe8696ddbe341f3280fe699c230f8f0fb31221e7a5740a91f485085f0
// (`platinum POST /v1/sandboxes/.../expose -> 409 {"code":"sandbox_not_running"}`).
//
// These drive the global fetch directly (no live server) so the classification
// is exercised deterministically without Bun.serve bind/stop timing.

const originalFetch = globalThis.fetch;
let fetchScenario: { status: number; body: string } = { status: 409, body: '' };

function mockFetchScenario() {
  const handler = (): Promise<Response> =>
    Promise.resolve(
      new Response(fetchScenario.body, {
        status: fetchScenario.status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  globalThis.fetch = handler as unknown as typeof fetch;
}

test('platinumJson throws PlatinumSandboxNotRunningError on 409 sandbox_not_running', async () => {
  fetchScenario = {
    status: 409,
    body: JSON.stringify({ error: 'sandbox not running', code: 'sandbox_not_running' }),
  };
  mockFetchScenario();

  const { platinumJson, isPlatinumSandboxNotRunningError, PlatinumSandboxNotRunningError } =
    await import('./platinum');

  const err = await platinumJson('/v1/sandboxes/sbx_1/expose', { method: 'POST' }).catch((e) => e);
  expect(err).toBeInstanceOf(PlatinumSandboxNotRunningError);
  expect(isPlatinumSandboxNotRunningError(err)).toBe(true);
  // The original diagnostics survive on the message so debugging still works.
  expect((err as Error).message).toContain('409');
  expect((err as Error).message).toContain('/expose');
  expect((err as Error).name).toBe('PlatinumSandboxNotRunningError');

  globalThis.fetch = originalFetch;
});

test('a 409 with a DIFFERENT code stays a generic Error (not misclassified as not-running)', async () => {
  fetchScenario = {
    status: 409,
    body: JSON.stringify({ error: 'port already exposed', code: 'port_in_use' }),
  };
  mockFetchScenario();

  const { platinumJson, isPlatinumSandboxNotRunningError } = await import('./platinum');
  const err = await platinumJson('/v1/sandboxes/sbx_1/expose', { method: 'POST' }).catch((e) => e);
  expect(isPlatinumSandboxNotRunningError(err)).toBe(false);
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).name).toBe('Error');
  expect((err as Error).message).toContain('409');

  globalThis.fetch = originalFetch;
});

test('a 500 / non-JSON 409 stays a generic Error (unexpected failures stay loud)', async () => {
  const { platinumJson, isPlatinumSandboxNotRunningError } = await import('./platinum');

  // 500 with a JSON body — a real upstream error, must NOT be classified.
  fetchScenario = { status: 500, body: JSON.stringify({ error: 'internal' }) };
  mockFetchScenario();
  let err = await platinumJson('/v1/sandboxes/sbx_1/expose', { method: 'POST' }).catch((e) => e);
  expect(isPlatinumSandboxNotRunningError(err)).toBe(false);
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).name).toBe('Error');
  expect((err as Error).message).toContain('500');

  // 409 with a NON-JSON body — the `code` field can't be parsed, so it must
  // NOT be classified (falls back to the generic Error).
  fetchScenario = { status: 409, body: 'not json at all' };
  err = await platinumJson('/v1/sandboxes/sbx_1/expose', { method: 'POST' }).catch((e) => e);
  expect(isPlatinumSandboxNotRunningError(err)).toBe(false);
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).name).toBe('Error');
  expect((err as Error).message).toContain('409');

  globalThis.fetch = originalFetch;
});

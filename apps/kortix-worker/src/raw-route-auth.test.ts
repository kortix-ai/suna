/**
 * The worker's RAW routes must be gated, like every `/kortix/opencode/*` one.
 *
 * `worker.ts` serves `/session/:id/prompt_async` and the bench surface itself
 * rather than through `RuntimeSurface`, and it called no auth check at all —
 * so those were the only routes on the box with none, purely because of where
 * they were served. `prompt_async` runs the agent with bash/read/write/edit
 * against the session's environment and the project's secrets.
 *
 * Severity note, so the next reader does not over- or under-rate this: a pi
 * box is a Daytona sandbox created with `public: false`
 * (apps/api/src/platform/providers/daytona.ts) and its preview link needs an
 * `X-Daytona-Preview-Token`, so this was defence-in-depth rather than an open
 * door. It is still wrong: the guard is free, every sibling has it, and the
 * provider's exposure setting is not something this file should depend on.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuntimeSurface } from './runtime-surface.ts';

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'worker.ts'), 'utf8');

/** Routes that must refuse an unauthenticated caller. */
const GATED = [
  "const m = url.pathname.match(/^\\/session\\/([^/]+)\\/prompt_async$/);",
  "if (url.pathname === '/events') {",
  "if (url.pathname === '/prompt' && req.method === 'POST') {",
  "if (url.pathname === '/turn' && req.method === 'POST') {",
  "if (url.pathname === '/say' && req.method === 'POST') {",
  "if (url.pathname === '/history') {",
  "if (url.pathname === '/interrupt' && req.method === 'POST') {",
];

describe('the worker gates its raw routes', () => {
  test('every raw route reaches an authorize() call', () => {
    // One guard per gated route, plus none missing.
    const guards = SRC.split('surface.authorize(req, url)').length - 1;
    expect(guards).toBeGreaterThanOrEqual(GATED.length);
  });

  for (const head of GATED) {
    const label = head.slice(0, 52).replace(/\s+/g, ' ');
    test(`guarded: ${label}`, () => {
      const at = SRC.indexOf(head);
      expect(at).toBeGreaterThan(-1);
      // The guard must appear within the handler, before it does any work.
      const window = SRC.slice(at, at + 900);
      expect(window).toContain('surface.authorize(req, url)');
    });
  }

  // Health stays open on purpose: the platform probes it before any credential
  // is available, exactly as it does for the OpenCode daemon.
  test('health endpoints stay unauthenticated', () => {
    for (const health of ["if (url.pathname === '/health') {", "if (url.pathname === '/kortix/health') {"]) {
      const at = SRC.indexOf(health);
      expect(at).toBeGreaterThan(-1);
      expect(SRC.slice(at, at + 240)).not.toContain('surface.authorize(req, url)');
    }
  });

  test('authorize() is a real check — it refuses when no token is configured', () => {
    const surface = new RuntimeSurface({ sessionId: 's' });
    const req = { method: 'POST', headers: {} } as never;
    expect(surface.authorize(req, new URL('http://x/session/abc/prompt_async'))).toBe(false);
  });

  test('authorize() accepts the session bearer', () => {
    const surface = new RuntimeSurface({ sessionId: 's', token: 'tok' });
    const ok = { method: 'POST', headers: { authorization: 'Bearer tok' } } as never;
    const bad = { method: 'POST', headers: { authorization: 'Bearer nope' } } as never;
    const url = new URL('http://x/session/abc/prompt_async');
    expect(surface.authorize(ok, url)).toBe(true);
    expect(surface.authorize(bad, url)).toBe(false);
  });
});

/**
 * A session that degraded to the faux provider must SAY SO in health.
 *
 * `KORTIX_MODEL_MODE` is set to 'real' for every session, and the LLM gateway
 * base URL is injected only when the gateway is enabled. With it off the worker
 * has no credential, hits `missingCredential`, and degrades to the scripted
 * faux provider — every prompt then answers emptily with no error anywhere the
 * product can see. (It does NOT leak a credential: the API never sets
 * KORTIX_API_KEY, so nothing is sent to a provider at all.)
 *
 * The code that added that degradation says "the reason is in /kortix/health
 * where it can be read". It was not: the payload had no field for it. This
 * makes the comment true, so an operator looking at a session answering
 * nonsense can tell WHY in one request.
 */
describe('/kortix/health reports a degraded model', () => {
  const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'worker.ts'), 'utf8');

  test('the payload carries model_mode', () => {
    expect(SRC).toContain('model_mode:');
  });

  test('the payload carries model_error, beside store_error', () => {
    // Same shape as store_error: null = fine, a string = answering but wrong.
    expect(SRC).toContain('model_error:');
  });

  test('the degradation sets that field rather than only logging', () => {
    const at = SRC.indexOf('missingCredential');
    expect(at).toBeGreaterThan(-1);
    expect(SRC).toMatch(/modelError\s*=/);
  });
});

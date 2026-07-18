import { describe, expect, test } from 'bun:test';

function setTestEnv(name: string, value: string): void {
  if (!process.env[name] || process.env[name]?.startsWith('encrypted:')) {
    process.env[name] = value;
  }
}

setTestEnv('DATABASE_URL', 'postgres://postgres:postgres@127.0.0.1:54322/postgres');
setTestEnv('SUPABASE_URL', 'http://127.0.0.1:54321');
setTestEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role');
setTestEnv('API_KEY_SECRET', 'test-api-key-secret');
setTestEnv('TUNNEL_SIGNING_SECRET', 'test-tunnel-signing-secret');
setTestEnv('ALLOWED_SANDBOX_PROVIDERS', 'platinum');
setTestEnv('KORTIX_URL', 'https://api.example.test');
setTestEnv('FRONTEND_URL', 'http://localhost:3000');
setTestEnv('INTERNAL_KORTIX_ENV', 'dev');
setTestEnv('RECALL_BASE_URL', 'https://us-west-2.recall.ai/api/v1');

const { isRetryablePlatinumBuildError } = await import('./platinum');

describe('Platinum build-error retry classifier', () => {
  test.each([
    ['stale staging context', new Error('build context does not exist')],
    ['S3 upload failure', new Error('build-context S3 upload -> 500 oops')],
    ['tar failure', new Error('tar build context failed')],
    ['network blip', new Error('fetch failed: network error')],
    ['upstream 502', new Error('platinum -> 502 Bad Gateway')],
    // A `from-build` registration that never surfaced via GET /v1/templates for
    // the ENTIRE waitForActive poll window — never even 'building', just gone.
    // Empirically a transient registration-pipeline flake on Platinum's side
    // (2026-07-18 dev incident), not a real build problem — see the classifier's
    // own comment for the live evidence. A fresh same-process retry is safe and
    // bounded (BUILD_ATTEMPTS).
    [
      'template never registered (stuck on "missing")',
      new Error('Platinum template kortix-default-3e3906a27df1 did not become ready (last state: missing)'),
    ],
  ])('retries %s', (_label, err) => {
    expect(isRetryablePlatinumBuildError(err)).toBe(true);
  });

  test.each([
    // An EXPLICIT build failure — Platinum registered the template, actually ran
    // the build, and it failed. Retrying would just fail identically.
    ['explicit build failure', new Error('Platinum template kortix-default-abc123 build failed')],
    // Reached a real (non-missing) state before giving up — a genuine stuck
    // build, not a registration no-show.
    [
      'activate timeout after reaching a real state',
      new Error('Platinum template kortix-default-abc123 did not become ready (last state: building)'),
    ],
    ['unrelated application error', new Error('unexpected token in JSON')],
  ])('does not retry %s', (_label, err) => {
    expect(isRetryablePlatinumBuildError(err)).toBe(false);
  });
});

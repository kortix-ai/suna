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

const {
  isRetryablePlatinumBuildError,
  isPlatinumSizeCapBuildFailure,
  PlatinumSizeCapBuildError,
} = await import('./platinum');

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
    [
      'per-org mutation RATE limit (transient, self-clears)',
      new Error('platinum POST /v1/templates/from-build -> 429 {"error":"rate limited","code":"rate_limited"}'),
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
    // Size-cap failures: a build ext4 ceiling too small for the image content
    // can never fit — the SAME content at the SAME ceiling fails identically
    // every time, so retrying is pure waste (see isPlatinumSizeCapBuildFailure).
    [
      'from-build registration rejects an oversize ceiling (size_mb too_big)',
      new Error('platinum POST /v1/templates/from-build -> 400 {"error":"size_mb too_big"}'),
    ],
    ['an ENOSPC-shaped async build failure', new Error('podman build failed: ENOSPC: no space left on device')],
    ['a "no space left on device" message without the ENOSPC code', new Error('write /var/lib: no space left on device')],
    ['an explicit "template size cap" message', new Error('Platinum template kortix-default-abc123 exceeded its template size cap')],
    ['the wrapped PlatinumSizeCapBuildError itself', new PlatinumSizeCapBuildError('kortix-default-abc123', new Error('size_mb too_big'))],
    // ALSO a 429, but the opposite of transient: the per-org template COUNT cap.
    // Nothing frees a template row on its own and Kortix has no org-wide GC for
    // Platinum, so retrying burns BUILD_ATTEMPTS against a wall and buries the
    // one error an operator needs to see.
    [
      'per-org template COUNT quota (permanent until a template is deleted)',
      new Error('platinum POST /v1/templates/from-build -> 429 {"error":"org template quota reached (500/500); delete an existing template first","code":"org_template_quota_exceeded","quota":500,"used":500}'),
    ],
  ])('does not retry %s', (_label, err) => {
    expect(isRetryablePlatinumBuildError(err)).toBe(false);
  });
});

describe('Platinum size-cap build-failure classifier', () => {
  test.each([
    ['from-build 400 size_mb too_big', new Error('platinum POST /v1/templates/from-build -> 400 {"error":"size_mb too_big"}')],
    ['ENOSPC-shaped async build failure', new Error('podman build failed: ENOSPC: no space left on device')],
    ['"no space left on device" without the ENOSPC code', new Error('write /var/lib: no space left on device')],
    ['explicit "template size cap" message', new Error('exceeded the template size cap')],
    ['a PlatinumSizeCapBuildError instance', new PlatinumSizeCapBuildError('kortix-default-abc123', new Error('size_mb too_big'))],
  ])('recognizes %s', (_label, err) => {
    expect(isPlatinumSizeCapBuildFailure(err)).toBe(true);
  });

  test.each([
    ['an unrelated build failure', new Error('Platinum template kortix-default-abc123 build failed')],
    ['a stale-context error', new Error('build context does not exist')],
    ['a plain network error', new Error('fetch failed: network error')],
  ])('does not misclassify %s as a size-cap failure', (_label, err) => {
    expect(isPlatinumSizeCapBuildFailure(err)).toBe(false);
  });

  test('wraps the original error with remediation naming PLATINUM_BUILD_SIZE_MB and a distinct log token', () => {
    const cause = new Error('platinum POST /v1/templates/from-build -> 400 {"error":"size_mb too_big"}');
    const wrapped = new PlatinumSizeCapBuildError('kortix-default-abc123', cause);
    expect(wrapped.message).toContain('PLATINUM_BUILD_SIZE_MB');
    expect(wrapped.message).toContain('kortix-default-abc123');
    expect(wrapped.message).toContain(cause.message);
    expect(wrapped.name).toBe('PlatinumSizeCapBuildError');
    // The wrapped error is itself recognized (idempotent re-classification).
    expect(isPlatinumSizeCapBuildFailure(wrapped)).toBe(true);
    expect(isRetryablePlatinumBuildError(wrapped)).toBe(false);
  });
});

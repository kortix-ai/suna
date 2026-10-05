import { afterEach, describe, expect, test } from 'bun:test';

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
setTestEnv('PLATINUM_API_URL', 'https://platinum.test');
setTestEnv('PLATINUM_API_KEY', 'pt_live_testkey');

const { waitForActive, requireExternalTemplateId, PlatinumTemplateBuildFailedError, summarizePlatinumBuildFailure } = await import('./platinum');

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('requireExternalTemplateId (PHASE 2 EXACT ID)', () => {
  test('accepts a non-empty id', () => {
    expect(requireExternalTemplateId('tpl_123', 'from-build for x')).toBe('tpl_123');
  });
  test.each([undefined, null, '', '   '])('rejects %p — never falls back to the name list', (bad) => {
    expect(() => requireExternalTemplateId(bad, 'from-build for x')).toThrow(/did not return a template id/);
  });
});

describe('waitForActive — PHASE 2 poll error classification', () => {
  test('a 401 during polling fails immediately (does not burn the deadline)', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return jsonResponse('bad key', 401);
    }) as unknown as typeof fetch;

    const started = Date.now();
    await expect(waitForActive('kortix-default-abc', undefined, 'tpl_abc')).rejects.toThrow(/401/);
    expect(Date.now() - started).toBeLessThan(2_000); // immediate, not a 12-min wait
    expect(calls).toBe(1);
  }, 10_000);

  test('a TLS cert failure fails immediately', async () => {
    globalThis.fetch = (async () => {
      const inner = Object.assign(new Error('certificate has expired'), { code: 'CERT_HAS_EXPIRED' });
      throw Object.assign(new TypeError('fetch failed'), { cause: inner });
    }) as unknown as typeof fetch;

    await expect(waitForActive('kortix-default-abc', undefined, 'tpl_abc')).rejects.toThrow();
  }, 10_000);

  test('an id that resolves to a different name is rejected (adopt mismatch)', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ id: 'tpl_abc', name: 'kortix-default-OTHER', state: 'ready' })) as unknown as typeof fetch;

    await expect(waitForActive('kortix-default-abc', undefined, 'tpl_abc')).rejects.toThrow(/mismatched template/);
  }, 10_000);

  test('resolves when the exact id reports ready', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ id: 'tpl_abc', name: 'kortix-default-abc', state: 'ready' })) as unknown as typeof fetch;

    await expect(waitForActive('kortix-default-abc', undefined, 'tpl_abc')).resolves.toBeUndefined();
  }, 10_000);

  test('a transient 503 does NOT fail the wait — it retries to ready', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) return jsonResponse('unavailable', 503);
      return jsonResponse({ id: 'tpl_abc', name: 'kortix-default-abc', state: 'ready' });
    }) as unknown as typeof fetch;

    await expect(waitForActive('kortix-default-abc', undefined, 'tpl_abc')).resolves.toBeUndefined();
    expect(calls).toBeGreaterThanOrEqual(2);
  }, 15_000);

  test('an explicit provider "failed" state is terminal', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ id: 'tpl_abc', name: 'kortix-default-abc', state: 'failed' })) as unknown as typeof fetch;

    await expect(waitForActive('kortix-default-abc', undefined, 'tpl_abc')).rejects.toThrow(/build failed/);
  }, 10_000);
});

// The shape of a real failure (slopcore-demo, 2026-10-05): a project Dockerfile's
// global ENV leaked into the appended Kortix layer, whose `uv python install`
// then died at STEP 15/49. Platinum stored all of this in build_logs; Kortix
// used to surface only "Platinum template … build failed".
const REAL_FAILURE_LOGS = [
  'STEP 15/49: RUN case "$(uname -m)" in x86_64) uv_arch=x86_64 ;; esac && uv python install --default 3.12.13',
  '/tmp/uv.tar.gz: OK',
  'warning: The `--default` option is experimental and may change without warning.',
  'error: failed to create file `/opt/uv-python/cpython-3.12.13-linux-x86_64-gnu/lib/python3.12/EXTERNALLY-MANAGED`: Permission denied (os error 13)',
  'Error: building at STEP "RUN case "$(uname -m)" in x86_64) uv_arch=x86_64 ;; esac && uv python install --default 3.12.13": while running runtime: exit status 2',
  '',
  '[build failed] podman build: exit status 2 — Error: building at STEP "RUN case …',
].join('\n');

describe('waitForActive — a failed build names its cause', () => {
  test('the error carries the failing log lines, and the tap gets the log tail', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ id: 'tpl_abc', name: 'kortix-default-abc', state: 'failed', build_logs: REAL_FAILURE_LOGS })) as unknown as typeof fetch;
    const lines: string[] = [];
    const err = await waitForActive('kortix-default-abc', { onLine: (l: string) => lines.push(l) } as never, 'tpl_abc').catch((e) => e);
    expect(err).toBeInstanceOf(PlatinumTemplateBuildFailedError);
    expect(err.message).toStartWith('Platinum template kortix-default-abc build failed: ');
    expect(err.message).toContain('Permission denied (os error 13)');
    expect(err.message).toContain('[build failed] podman build: exit status 2');
    // The standalone `Error: building at STEP …` echo is dropped; only the trailer's copy remains.
    expect(err.message.split('Error: building at STEP').length - 1).toBe(1);
    expect(lines).toContain('/tmp/uv.tar.gz: OK');
  }, 10_000);

  test('reads the detail row when the polled row has no logs', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return calls === 1
        ? jsonResponse({ id: 'tpl_abc', name: 'kortix-default-abc', state: 'failed' })
        : jsonResponse({ id: 'tpl_abc', name: 'kortix-default-abc', state: 'failed', buildLogs: REAL_FAILURE_LOGS });
    }) as unknown as typeof fetch;
    await expect(waitForActive('kortix-default-abc', undefined, 'tpl_abc')).rejects.toThrow(/Permission denied/);
    expect(calls).toBe(2);
  }, 10_000);

  test('no logs anywhere still fails with the plain message', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ id: 'tpl_abc', name: 'kortix-default-abc', state: 'failed' })) as unknown as typeof fetch;
    const err = await waitForActive('kortix-default-abc', undefined, 'tpl_abc').catch((e) => e);
    expect(err).toBeInstanceOf(PlatinumTemplateBuildFailedError);
    expect(err.message).toBe('Platinum template kortix-default-abc build failed');
  }, 10_000);
});

describe('summarizePlatinumBuildFailure', () => {
  test('keeps the causal error lines plus the [build failed] trailer, bounded', () => {
    const s = summarizePlatinumBuildFailure(REAL_FAILURE_LOGS);
    expect(s).toContain('error: failed to create file');
    expect(s).toEndWith('[build failed] podman build: exit status 2 — Error: building at STEP "RUN case …');
    expect(s.length).toBeLessThanOrEqual(1_201);
  });

  test('falls back to the last lines when nothing looks like an error', () => {
    expect(summarizePlatinumBuildFailure('a\nb\nc\nd')).toBe('b | c | d');
  });

  test('empty logs give an empty summary', () => {
    expect(summarizePlatinumBuildFailure('')).toBe('');
    expect(summarizePlatinumBuildFailure(null)).toBe('');
  });

  test('a single enormous line is clipped', () => {
    const s = summarizePlatinumBuildFailure(`error: ${'x'.repeat(5_000)}\n[build failed] boom`);
    expect(s.length).toBeLessThan(1_000);
  });
});

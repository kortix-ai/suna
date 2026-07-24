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
setTestEnv('RECALL_BASE_URL', 'https://us-west-2.recall.ai/api/v1');
setTestEnv('PLATINUM_API_URL', 'https://platinum.test');
setTestEnv('PLATINUM_API_KEY', 'pt_live_testkey');

const { findTemplateByName, PlatinumTemplateListingError, platinumProvider } = await import('./platinum');

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Parse `?offset=` off a /v1/templates request URL (default 0). */
function offsetOf(input: RequestInfo | URL): number {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
  return Number(new URL(url, 'https://platinum.test').searchParams.get('offset') ?? '0');
}

function tpl(name: string): { id: string; name: string; state: string } {
  return { id: `id-${name}`, name, state: 'ready' };
}

describe('FIX-C — findTemplateByName paginates the /v1/templates list', () => {
  test('finds a template on page 2 (never a false-absent past the first 50)', async () => {
    // Page 0 = 50 filler templates (created_at DESC), page 1 = the sought one.
    const page0 = Array.from({ length: 50 }, (_, i) => tpl(`filler-${i}`));
    const page1 = [tpl('kortix-ppwarm-OLD')];
    let calls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls += 1;
      return jsonResponse(offsetOf(input) === 0 ? page0 : page1);
    }) as unknown as typeof fetch;

    const found = await findTemplateByName('kortix-ppwarm-OLD');
    expect(found?.id).toBe('id-kortix-ppwarm-OLD');
    expect(calls).toBe(2); // walked past the first full page
  });

  test('early-exits once the name is found (no needless extra page fetches)', async () => {
    const page0 = [tpl('kortix-ppwarm-NEW'), ...Array.from({ length: 49 }, (_, i) => tpl(`f-${i}`))];
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return jsonResponse(page0);
    }) as unknown as typeof fetch;

    const found = await findTemplateByName('kortix-ppwarm-NEW');
    expect(found?.id).toBe('id-kortix-ppwarm-NEW');
    expect(calls).toBe(1); // found on page 0 → stop, do not fetch page 1
  });

  test('a genuinely absent name returns null after exhausting the list (short last page)', async () => {
    const page0 = Array.from({ length: 50 }, (_, i) => tpl(`filler-${i}`));
    const page1 = Array.from({ length: 10 }, (_, i) => tpl(`filler-b-${i}`)); // < 50 → last page
    globalThis.fetch = (async (input: RequestInfo | URL) =>
      jsonResponse(offsetOf(input) === 0 ? page0 : page1)) as unknown as typeof fetch;

    await expect(findTemplateByName('kortix-ppwarm-NOPE')).resolves.toBeNull();
  });

  test('a page-fetch error surfaces as a listing FAILURE — never a false absent', async () => {
    globalThis.fetch = (async () => jsonResponse('bad gateway', 502)) as unknown as typeof fetch;
    await expect(findTemplateByName('kortix-ppwarm-x')).rejects.toBeInstanceOf(PlatinumTemplateListingError);
  });

  test('a mid-scan page error (page 1 fails after page 0 succeeded) still throws, never truncates to absent', async () => {
    const page0 = Array.from({ length: 50 }, (_, i) => tpl(`filler-${i}`));
    globalThis.fetch = (async (input: RequestInfo | URL) =>
      offsetOf(input) === 0 ? jsonResponse(page0) : jsonResponse('boom', 500)) as unknown as typeof fetch;

    await expect(findTemplateByName('kortix-ppwarm-past-page-0')).rejects.toBeInstanceOf(PlatinumTemplateListingError);
  });

  test('an offset-ignoring server (same page repeated) does NOT spin — stops on the no-new-ids guard', async () => {
    const samePage = Array.from({ length: 50 }, (_, i) => tpl(`filler-${i}`));
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return jsonResponse(samePage); // ignores offset: always the same 50
    }) as unknown as typeof fetch;

    await expect(findTemplateByName('kortix-ppwarm-not-here')).resolves.toBeNull();
    expect(calls).toBe(2); // page 0, then page 1 (all-duplicate ids) → stop
  });

  test('a full list past the hard page cap throws (never a silent truncation → absent)', async () => {
    let n = 0;
    globalThis.fetch = (async () =>
      // Always a full page of BRAND-NEW ids → advances forever until the cap.
      jsonResponse(Array.from({ length: 50 }, () => tpl(`u-${n++}`)))) as unknown as typeof fetch;

    await expect(findTemplateByName('kortix-ppwarm-deep')).rejects.toBeInstanceOf(PlatinumTemplateListingError);
  });
});

describe('FIX-C — getSnapshotState treats a failed listing as indeterminate, never "missing"', () => {
  test('a 5xx listing failure degrades to "unknown" (NOT "missing" → no needless rebuild)', async () => {
    globalThis.fetch = (async () => jsonResponse('unavailable', 503)) as unknown as typeof fetch;
    await expect(platinumProvider.getSnapshotState('kortix-ppwarm-x')).resolves.toBe('unknown');
  });

  test('a genuinely absent template (exhausted list) is "missing"', async () => {
    globalThis.fetch = (async () =>
      jsonResponse(Array.from({ length: 3 }, (_, i) => tpl(`other-${i}`)))) as unknown as typeof fetch;
    await expect(platinumProvider.getSnapshotState('kortix-ppwarm-x')).resolves.toBe('missing');
  });

  test('a 403 listing failure still PROPAGATES (auth is never degraded to a state)', async () => {
    globalThis.fetch = (async () => jsonResponse({ error: 'forbidden' }, 403)) as unknown as typeof fetch;
    await expect(platinumProvider.getSnapshotState('kortix-ppwarm-x')).rejects.toThrow(/403/);
  });
});

describe('FIX-C — listSnapshots returns the FULL paginated set', () => {
  test('spans multiple pages (reaper sees superseded tips past page 1)', async () => {
    const page0 = Array.from({ length: 50 }, (_, i) => tpl(`kortix-ppwarm-${i}`));
    const page1 = [tpl('kortix-ppwarm-old-a'), tpl('kortix-ppwarm-old-b')];
    globalThis.fetch = (async (input: RequestInfo | URL) =>
      jsonResponse(offsetOf(input) === 0 ? page0 : page1)) as unknown as typeof fetch;

    const names = (await platinumProvider.listSnapshots()).map((s) => s.name);
    expect(names).toHaveLength(52);
    expect(names).toContain('kortix-ppwarm-old-a');
    expect(names).toContain('kortix-ppwarm-old-b');
  });
});

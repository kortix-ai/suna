// pi-js.kortix.com fronts a shell-capable agent with no auth of its own, so the
// Worker's two guards are claimed here: the upstream origin can never be moved
// by the incoming path, and the name fails closed without an access policy.
// Both were findings on #7125 (Strix: CWE-918, CWE-306).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import worker, { accessRefusal, consumedHeaders, presentedAccess, upstreamUrl } from '../../infra/cloudflare/workers/pi-js-router/worker.mjs';

const TARGET = 'https://8080-01m1s178mtjdff5gst7jqvc735.eu-west.sbx-dev.platinum.dev';
const workflow = readFileSync(
  resolve(import.meta.dirname, '../../.github/workflows/deploy-pi-js-router.yml'),
  'utf8',
);

describe('deploy-pi-js-router.yml — the name fronts the bare cell OR a full Kortix branch environment', () => {
  it('offers target_kind=cell|stack and defaults to the cell', () => {
    expect(workflow).toMatch(/target_kind:\n\s+description:/);
    expect(workflow).toMatch(/options:\n\s+- cell\n\s+- stack/);
    expect(workflow).toContain("TARGET_KIND: ${{ inputs.target_kind || 'cell' }}");
  });

  it('a stack is a Platinum branch-environment origin, proven by /v1/health, run open, with no exposure token stored', () => {
    // deploy-preview.yml exposes the sandbox's 8080 public on Platinum PROD
    // (`8080-<sandbox>.eu-west.sbx.platinum.dev`) and the stack has its own auth.
    expect(workflow).toContain('https://8080-*.sbx.platinum.dev|https://8080-*.sbx.platinum.dev/');
    expect(workflow).toContain(`"\${TARGET_ORIGIN%/}/v1/health"`);
    expect(workflow).toContain("jq -e '.status == \"ok\"'");
    expect(workflow).toContain('target_kind=stack requires open_access=true');
    // The DEV cell's exposure token must not ride along to a PROD stack.
    expect(workflow).toMatch(/if \[ "\$TARGET_KIND" = stack \]; then\n\s+#[^\n]*\n\s+#[^\n]*\n\s+npx --yes wrangler@4 secret delete PT_PREVIEW_TOKEN --force/);
  });

  it('a cell still needs its DEV origin, the exposure token, and an access policy', () => {
    expect(workflow).toContain('https://8080-*.sbx-dev.platinum.dev|https://8080-*.sbx-dev.platinum.dev/) ;;');
    expect(workflow).toContain('PI_JS_PREVIEW_TOKEN is not set');
    expect(workflow).toContain('PI_JS_ACCESS_TOKEN is not set and open_access was not chosen');
    expect(workflow).toContain('-H "x-pt-preview-token: $PT_PREVIEW_TOKEN" "${TARGET_ORIGIN%/}/health"');
  });
});

describe('upstreamUrl — the origin is always the configured target', () => {
  it('copies path and query onto the target origin', () => {
    const u = upstreamUrl(TARGET, 'https://pi-js.kortix.com/session-read?c=abc&x=1#frag');
    expect(u?.origin).toBe(TARGET);
    expect(u?.pathname).toBe('/session-read');
    expect(u?.search).toBe('?c=abc&x=1');
    expect(u?.hash).toBe('');
  });

  it('refuses a scheme-relative path instead of forwarding the exposure token to another host', () => {
    // new URL('//evil.example/x', TARGET) resolves to https://evil.example/x — the bug this replaces.
    expect(upstreamUrl(TARGET, 'https://pi-js.kortix.com//evil.example/x')).toBeNull();
    expect(upstreamUrl(TARGET, 'https://pi-js.kortix.com/\\evil.example/x')).toBeNull();
    // A path that merely CONTAINS a double slash later is ordinary and stays on the target.
    expect(upstreamUrl(TARGET, 'https://pi-js.kortix.com/a//b')?.origin).toBe(TARGET);
  });

  it('never resolves against the target even for absolute-looking paths', () => {
    const u = upstreamUrl(TARGET, 'https://pi-js.kortix.com/https://evil.example/x');
    expect(u?.origin).toBe(TARGET);
    expect(u?.pathname).toBe('/https://evil.example/x');
  });
});

describe('accessRefusal — the name fails closed', () => {
  const req = (headers: Record<string, string> = {}) => new Request('https://pi-js.kortix.com/health', { headers });

  it('answers 503 when there is no ACCESS_TOKEN and open access was not chosen', async () => {
    const r = accessRefusal(req(), {});
    expect(r?.status).toBe(503);
    expect((await r!.json()).error).toMatch(/not configured/);
  });

  it('is open only when the operator deployed OPEN_ACCESS=true — and only the exact string', () => {
    expect(accessRefusal(req(), { OPEN_ACCESS: 'true' })).toBeNull();
    expect(accessRefusal(req(), { OPEN_ACCESS: 'yes' })?.status).toBe(503);
    expect(accessRefusal(req(), { OPEN_ACCESS: '1' })?.status).toBe(503);
  });

  it('with ACCESS_TOKEN set: the right bearer or x-kortix-access passes, anything else is 401 with a challenge', () => {
    const env = { ACCESS_TOKEN: 'k-secret-1' };
    expect(accessRefusal(req({ authorization: 'Bearer k-secret-1' }), env)).toBeNull();
    expect(accessRefusal(req({ 'x-kortix-access': 'k-secret-1' }), env)).toBeNull();
    const wrong = accessRefusal(req({ authorization: 'Bearer k-secret-2' }), env);
    expect(wrong?.status).toBe(401);
    expect(wrong?.headers.get('www-authenticate')).toContain('Bearer');
    expect(accessRefusal(req(), env)?.status).toBe(401);
    // OPEN_ACCESS=true is the operator's explicit deploy-time choice and wins
    // over a bearer still stored — the owner opened the name and a stale
    // ACCESS_TOKEN kept answering 401 (2026-09-05).
    expect(accessRefusal(req(), { ...env, OPEN_ACCESS: 'true' })).toBeNull();
    expect(accessRefusal(req(), { ...env, OPEN_ACCESS: 'yes' })?.status).toBe(401);
  });

  it('presentedAccess reads the bearer first, then x-kortix-access, trimmed', () => {
    expect(presentedAccess(new Headers({ authorization: 'bearer  abc ' }))).toBe('abc');
    expect(presentedAccess(new Headers({ 'x-kortix-access': ' xyz' }))).toBe('xyz');
    expect(presentedAccess(new Headers({ authorization: 'Basic zzz' }))).toBe('');
  });
});

describe('the caller\'s Authorization header is consumed ONLY when this name asked for it', () => {
  // With OPEN_ACCESS=true the Worker asked for nothing, so an Authorization
  // header belongs to the origin: the Kortix stack behind pi-js.kortix.com
  // authenticates its own users with a Supabase JWT in that header. Deleting it
  // unconditionally made every signed-in call answer the API's "Missing or
  // invalid Authorization header" (2026-09-05: the owner could not sign in with
  // email). Claimed at the fetch handler itself, with the upstream fetch
  // captured, not only at the helper.
  const upstreamOf = async (env: Record<string, string>, headers: Record<string, string>) => {
    let seen: Request | null = null;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Request) => { seen = input; return new Response('ok', { status: 200 }); }) as any;
    try {
      await worker.fetch(new Request('https://pi-js.kortix.com/api/agents', { headers }), { TARGET_ORIGIN: TARGET, ...env });
    } finally { globalThis.fetch = realFetch; }
    return seen!;
  };

  it('OPEN_ACCESS=true forwards the caller\'s bearer to the origin untouched — the stack authenticates its own users', async () => {
    expect(consumedHeaders({ OPEN_ACCESS: 'true' })).not.toContain('authorization');
    const up = await upstreamOf({ OPEN_ACCESS: 'true' }, { authorization: 'Bearer supabase-jwt', 'x-kortix-access': 'nope' });
    expect(up.headers.get('authorization')).toBe('Bearer supabase-jwt');
    expect(up.headers.get('x-kortix-access')).toBeNull();   // this Worker's own header never means anything upstream
    expect(up.url.startsWith(TARGET)).toBe(true);
  });

  it('ACCESS_TOKEN mode consumes the bearer that opened the door — the origin never sees this name\'s credential', async () => {
    expect(consumedHeaders({ ACCESS_TOKEN: 'k-secret-1' })).toContain('authorization');
    const up = await upstreamOf({ ACCESS_TOKEN: 'k-secret-1' }, { authorization: 'Bearer k-secret-1' });
    expect(up.headers.get('authorization')).toBeNull();
  });
});

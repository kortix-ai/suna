/**
 * The streaming relay route, black-box over its REAL wire contract.
 *
 * What is mocked: the database, project access, secret decryption, audit, and
 * the upstream transport (`relay-transport.ts`, which has its own tests against
 * a real TLS socket). What is NOT mocked, deliberately: the relay meta codec,
 * the whole policy gate (`prepareRelayHead`), the authorization core
 * (`relay-authorize.ts`), and both substituters. Those are the security
 * contract — a test that mocked them would be asserting its own fixtures.
 */
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  projectSecrets,
  projectSessionSecretHandles,
  projectSessions,
  sessionSandboxes,
} from '@kortix/db';
import {
  decodeRelayStatus,
  encodeRelayMeta,
  RELAY_ERROR_HEADER,
  RELAY_META_HEADER,
  RELAY_PROBE_HEADER,
  RELAY_STATUS_HEADER,
  RELAY_VERSION_HEADER,
  type SecretRelayMeta,
} from '@kortix/api-contract/secret-relay';
import { Hono } from 'hono';
import { config } from '../config';
import * as realAccess from '../projects/lib/access';
import * as realProjectSecrets from '../projects/secrets';
import { mintHandle } from '../secrets/strategy';

const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const ACCOUNT_ID = '44444444-4444-4444-8444-444444444444';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '55555555-5555-4555-8555-555555555555';
const SECRET_ID = '66666666-6666-4666-8666-666666666666';
const LOOKUP_ID = 'aaaaaaaaaaaaaaaaaaaa';
const SECRET_VALUE = 'sk_live_the_real_value';

const POLICY = {
  backend: 'kortix_fetch' as const,
  rules: [{ host: 'api.example.com', methods: ['GET', 'POST'], path: '/v1/*' }],
};

const HANDLE = mintHandle({ lookupId: LOOKUP_ID, prefix: null, rootSecret: config.API_KEY_SECRET });

let authType: 'pat' | 'supabase' = 'pat';
let tokenProjectId: string | undefined = PROJECT_ID;
let sessionId: string | undefined = SESSION_ID;
let agentGrant: Record<string, unknown> | null = {
  agent: 'default',
  kortixCli: 'all',
  connectors: 'all',
  env: ['PRIMARY'],
};
let sessionRow: Record<string, unknown> | null = {
  sessionId: SESSION_ID,
  secretsAllowlist: ['PRIMARY'],
};
let secretRows: Array<Record<string, unknown>> = [];
let handleRows: Array<Record<string, unknown>> = [];
const audits: Array<Record<string, unknown>> = [];
let sandboxRow: { metadata: Record<string, unknown> } | null = null;

function sharedSecret(overrides: Record<string, unknown> = {}) {
  return {
    secretId: SECRET_ID,
    identifier: 'PRIMARY',
    ownerUserId: null,
    valueEnc: 'shared-encrypted-value',
    active: true,
    strategy: 'broker',
    egressPolicy: POLICY,
    handlePrefix: null,
    ...overrides,
  };
}

function handleFor(overrides: Record<string, unknown> = {}) {
  return {
    secretId: SECRET_ID,
    identifier: 'PRIMARY',
    lookupId: LOOKUP_ID,
    handleHash: createHash('sha256').update(HANDLE).digest('hex'),
    policySnapshot: POLICY,
    expiresAt: null,
    ...overrides,
  };
}

const databaseMock = {
  select: () => ({
    from: (table: unknown) => ({
      where: () => {
        if (table === projectSessions) return { limit: async () => (sessionRow ? [sessionRow] : []) };
        if (table === sessionSandboxes) {
          return { limit: async () => (sandboxRow ? [sandboxRow] : []) };
        }
        if (table === projectSecrets) return Promise.resolve(secretRows);
        if (table === projectSessionSecretHandles) return { orderBy: async () => handleRows };
        throw new Error('unexpected table');
      },
    }),
  }),
};

mock.module('../shared/db', () => ({ db: databaseMock, hasDatabase: true }));
mock.module('../projects/lib/access', () => ({
  ...realAccess,
  loadProjectForUser: async () => ({
    row: { accountId: ACCOUNT_ID, projectId: PROJECT_ID },
    userId: USER_ID,
  }),
}));
mock.module('../projects/secrets', () => ({
  ...realProjectSecrets,
  decryptProjectSecret: () => SECRET_VALUE,
}));
mock.module('../shared/audit', () => ({
  recordAuditEvent: async (event: Record<string, unknown>) => {
    audits.push(event);
  },
}));

// ── The upstream, mocked at the transport boundary ─────────────────────────
interface UpstreamCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** Everything the route actually wrote to the upstream. */
  body: Buffer;
  /** The chunk sizes, so "did it STREAM" is observable, not assumed. */
  chunks: number[];
}
let upstreamCalls: UpstreamCall[] = [];
let upstreamStatus = 200;
let upstreamHeaders: Array<[string, string]> = [['content-type', 'application/json']];
/** Per-hop scripted responses, for redirect tests. Consumed in order. */
let upstreamScript: Array<{ status: number; headers: Array<[string, string]> }> = [];
/** What the upstream writes back, as discrete chunks. */
let upstreamBody: string[] = ['{"ok":true}'];
let upstreamDelayMs = 0;
/** Destroy the upstream body after N pieces, to model a mid-stream death. */
let upstreamFailAfter: number | null = null;

mock.module('../secrets/relay-transport', () => ({
  RELAY_CONNECT_TIMEOUT_MS: 10_000,
  openUpstream: async (
    head: { url: URL; method: string; headers: Record<string, string> },
    body: Readable | Buffer | null,
  ) => {
    const call: UpstreamCall = {
      url: head.url.href,
      method: head.method,
      headers: head.headers,
      body: Buffer.alloc(0),
      chunks: [],
    };
    upstreamCalls.push(call);
    const scripted = upstreamScript.shift();
    if (Buffer.isBuffer(body)) {
      call.body = body;
      call.chunks.push(body.byteLength);
    } else if (body) {
      const parts: Buffer[] = [];
      for await (const chunk of body) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
        parts.push(buffer);
        call.chunks.push(buffer.byteLength);
      }
      call.body = Buffer.concat(parts);
    }
    const out = new Readable({ read() {} });
    void (async () => {
      let written = 0;
      for (const piece of upstreamBody) {
        if (upstreamDelayMs) await new Promise((r) => setTimeout(r, upstreamDelayMs));
        out.push(Buffer.from(piece));
        written += 1;
        if (upstreamFailAfter !== null && written >= upstreamFailAfter) {
          // Exactly what relay-transport does on an idle timeout or a blown
          // response budget: destroy the stream mid-body.
          //
          // The delay is not cosmetic. Measured on bun 1.3.14: destroying a
          // Readable in the SAME tick as the push that preceded it makes
          // `Readable.toWeb` drop BOTH the data and the error — the consumer
          // sees a clean, empty stream. Every real destroy site
          // (`relay-transport.ts` armIdle, the byte-budget check, the
          // `'error'` handler) runs on a later tick, so this models production
          // and not that quirk.
          await new Promise((r) => setTimeout(r, 5));
          out.destroy(new Error('upstream stream went idle'));
          return;
        }
      }
      out.push(null);
    })();
    return {
      status: scripted?.status ?? upstreamStatus,
      rawHeaders: scripted?.headers ?? upstreamHeaders,
      body: out,
      destroy: () => out.destroy(),
    };
  },
}));

const { projectsApp } = await import('../projects/lib/app');
await import('../projects/routes/secret-relay');

function buildApp() {
  const app = new Hono<{
    Variables: {
      userId: string;
      authType: 'pat' | 'supabase';
      tokenProjectId?: string;
      sessionId?: string;
      agentGrant?: Record<string, unknown> | null;
    };
  }>();
  app.use('*', async (c, next) => {
    c.set('userId', USER_ID);
    c.set('authType', authType);
    if (tokenProjectId) c.set('tokenProjectId', tokenProjectId);
    if (sessionId) c.set('sessionId', sessionId);
    c.set('agentGrant', agentGrant);
    await next();
  });
  app.route('/v1/projects', projectsApp);
  return app;
}

function meta(overrides: Partial<SecretRelayMeta> = {}): SecretRelayMeta {
  return {
    v: 1,
    url: 'https://api.example.com/v1/messages',
    method: 'POST',
    headers: [['content-type', 'application/json']],
    body: { present: false },
    ...overrides,
  } as SecretRelayMeta;
}

function relay(
  init: { meta?: SecretRelayMeta | string | null; body?: BodyInit | null; headers?: Record<string, string> } = {},
) {
  const headers: Record<string, string> = {
    'content-type': 'application/octet-stream',
    [RELAY_VERSION_HEADER]: '1',
    ...(init.headers ?? {}),
  };
  const m = init.meta === undefined ? meta() : init.meta;
  if (m !== null) headers[RELAY_META_HEADER] = typeof m === 'string' ? m : encodeRelayMeta(m);
  return buildApp().request(`/v1/projects/${PROJECT_ID}/secrets/PRIMARY/relay`, {
    method: 'POST',
    headers,
    ...(init.body != null ? { body: init.body } : {}),
  });
}

beforeEach(() => {
  authType = 'pat';
  tokenProjectId = PROJECT_ID;
  sessionId = SESSION_ID;
  agentGrant = { agent: 'default', kortixCli: 'all', connectors: 'all', env: ['PRIMARY'] };
  sessionRow = { sessionId: SESSION_ID, secretsAllowlist: ['PRIMARY'] };
  secretRows = [sharedSecret()];
  handleRows = [handleFor()];
  sandboxRow = null;
  audits.length = 0;
  upstreamCalls = [];
  upstreamStatus = 200;
  upstreamHeaders = [['content-type', 'application/json']];
  upstreamBody = ['{"ok":true}'];
  upstreamDelayMs = 0;
  upstreamFailAfter = null;
  upstreamScript = [];
});

describe('the capability probe', () => {
  test('answers 204 with the protocol version', async () => {
    const response = await relay({ meta: null, headers: { [RELAY_PROBE_HEADER]: '1' } });
    expect(response.status).toBe(204);
    expect(response.headers.get(RELAY_VERSION_HEADER)).toBe('1');
  });

  test('costs nothing: it never touches the secret or writes an audit row', async () => {
    await relay({ meta: null, headers: { [RELAY_PROBE_HEADER]: '1' } });
    expect(audits).toEqual([]);
    expect(upstreamCalls).toEqual([]);
  });

  test('still requires the session-scoped agent token', async () => {
    authType = 'supabase';
    const response = await relay({ meta: null, headers: { [RELAY_PROBE_HEADER]: '1' } });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'session_agent_token_required' });
  });
});

describe('the meta header is validated before anything else happens', () => {
  test('a missing meta is 400 relay_meta_invalid', async () => {
    const response = await relay({ meta: null });
    expect(response.status).toBe(400);
    expect(response.headers.get(RELAY_ERROR_HEADER)).toBe('relay_meta_invalid');
    expect(await response.json()).toMatchObject({ code: 'relay_meta_invalid' });
  });

  test('an oversized meta is 400 relay_meta_too_large', async () => {
    const response = await relay({ meta: 'A'.repeat(70_000) });
    expect(response.status).toBe(400);
    expect(response.headers.get(RELAY_ERROR_HEADER)).toBe('relay_meta_too_large');
  });

  test('a malformed meta never reaches the upstream', async () => {
    await relay({ meta: 'not-base64-json' });
    expect(upstreamCalls).toEqual([]);
  });
});

describe('the relay-200 vs relay-error disambiguation — the load-bearing rule', () => {
  test('an out-of-policy host is 403 policy_denied with NO status header', async () => {
    const response = await relay({ meta: meta({ url: 'https://evil.example.com/v1/x' }) });
    expect(response.status).toBe(403);
    expect(response.headers.get(RELAY_STATUS_HEADER)).toBeNull();
    expect(response.headers.get(RELAY_ERROR_HEADER)).toBe('policy_denied');
    expect(await response.json()).toMatchObject({ code: 'policy_denied' });
  });

  test('an upstream 429 is relay 200 WITH a status header carrying 429', async () => {
    // The distinction the legacy JSON envelope preserves and this contract must
    // not lose: "Kortix denied you" and "Stripe rate-limited you" are different
    // facts and the agent acts differently on each.
    upstreamStatus = 429;
    upstreamHeaders = [
      ['content-type', 'application/json'],
      ['retry-after', '5'],
    ];
    const response = await relay();
    expect(response.status).toBe(200);
    const status = decodeRelayStatus(response.headers.get(RELAY_STATUS_HEADER)!);
    expect(status.status).toBe(429);
    expect(status.headers).toContainEqual(['retry-after', '5']);
  });

  test('an upstream 403 is ALSO relay 200 — never mirrored onto our own status', async () => {
    upstreamStatus = 403;
    const response = await relay();
    expect(response.status).toBe(200);
    expect(decodeRelayStatus(response.headers.get(RELAY_STATUS_HEADER)!).status).toBe(403);
    expect(response.headers.get(RELAY_ERROR_HEADER)).toBeNull();
  });
});

describe('substitution covers every carrier the guest can use', () => {
  test('a handle in a request HEADER is replaced with the real value', async () => {
    await relay({
      meta: meta({ headers: [['authorization', `Bearer ${HANDLE}`]] }),
    });
    expect(upstreamCalls[0]?.headers.authorization).toBe(`Bearer ${SECRET_VALUE}`);
  });

  test('a handle in the URL QUERY is replaced', async () => {
    await relay({ meta: meta({ url: `https://api.example.com/v1/m?key=${HANDLE}`, method: 'GET' }) });
    expect(upstreamCalls[0]?.url).toContain(encodeURIComponent(SECRET_VALUE));
    expect(upstreamCalls[0]?.url).not.toContain(HANDLE);
  });

  test('a handle in the request BODY is replaced', async () => {
    const body = JSON.stringify({ token: HANDLE });
    await relay({
      meta: meta({ body: { present: true, length: body.length } }),
      body,
    });
    expect(upstreamCalls[0]?.body.toString()).toBe(JSON.stringify({ token: SECRET_VALUE }));
  });

  test('a handle SPLIT ACROSS chunk boundaries in a streamed body is still replaced', async () => {
    // The bug class this whole design exists to prevent. The body is over the
    // exact-length threshold, so it takes the streaming path, and the handle is
    // deliberately straddling a chunk edge.
    const filler = 'x'.repeat(70_000);
    const text = `${filler}{"token":"${HANDLE}"}`;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        const bytes = Buffer.from(text);
        // Cut INSIDE the handle.
        const cut = text.indexOf(HANDLE) + 11;
        controller.enqueue(bytes.subarray(0, cut));
        controller.enqueue(bytes.subarray(cut));
        controller.close();
      },
    });
    await relay({
      meta: meta({ body: { present: true, length: null } }),
      body: source,
    });
    const sent = upstreamCalls[0]!.body.toString();
    expect(sent).toContain(SECRET_VALUE);
    expect(sent).not.toContain(HANDLE);
    expect(upstreamCalls[0]!.chunks.length).toBeGreaterThan(1);
  });

  test('a handle this session may NOT spend is left alone, not substituted', async () => {
    agentGrant = { agent: 'default', kortixCli: 'all', connectors: 'all', env: [] };
    const response = await relay({ meta: meta({ headers: [['authorization', `Bearer ${HANDLE}`]] }) });
    // The route's own secret is no longer deliverable, so the relay refuses
    // outright rather than sending a request with a worthless string in it.
    expect(response.status).toBe(403);
    expect(upstreamCalls).toEqual([]);
  });
});

describe('echo redaction is inline, on BOTH exits', () => {
  test('a secret echoed in the streamed body comes back [REDACTED]', async () => {
    upstreamBody = [`{"echo":"${SECRET_VALUE}"}`];
    const response = await relay();
    expect(await response.text()).toBe('{"echo":"[REDACTED]"}');
  });

  test('a secret SPLIT across upstream chunks is still redacted', async () => {
    const half = Math.floor(SECRET_VALUE.length / 2);
    upstreamBody = [`{"echo":"${SECRET_VALUE.slice(0, half)}`, `${SECRET_VALUE.slice(half)}"}`];
    const response = await relay();
    expect(await response.text()).toBe('{"echo":"[REDACTED]"}');
  });

  test('a secret echoed in a WHITELISTED response header comes back [REDACTED]', async () => {
    // The body is not the only exit.
    upstreamHeaders = [
      ['content-type', 'application/json'],
      ['x-request-id', `req_${SECRET_VALUE}`],
    ];
    const response = await relay();
    const status = decodeRelayStatus(response.headers.get(RELAY_STATUS_HEADER)!);
    expect(status.headers).toContainEqual(['x-request-id', 'req_[REDACTED]']);
  });

  test('response headers outside the whitelist never travel', async () => {
    upstreamHeaders = [
      ['content-type', 'application/json'],
      ['set-cookie', 'session=abc'],
      ['content-length', '11'],
      ['transfer-encoding', 'chunked'],
    ];
    const response = await relay();
    const names = decodeRelayStatus(response.headers.get(RELAY_STATUS_HEADER)!).headers.map(
      ([n]) => n,
    );
    expect(names).toEqual(['content-type']);
  });

  // REGRESSION. `prepareRelayHead` forces `accept-encoding: identity` upstream
  // precisely so the echo scan sees plaintext, but nothing verified the
  // upstream OBEYED — and `content-encoding` is not in SAFE_RESPONSE_HEADERS,
  // so a gzip body was piped through a redactor that cannot match compressed
  // bytes and handed to the guest as undeclared compressed data. With the 5 MiB
  // response cap gone, the volume of unredacted upstream bytes reachable
  // through that gap was unbounded. Fail closed instead.
  test('a compressed upstream body is REFUSED, not relayed unredacted', async () => {
    upstreamHeaders = [
      ['content-type', 'application/json'],
      ['content-encoding', 'gzip'],
    ];
    upstreamBody = ['\u001f\u008b compressed bytes'];
    const response = await relay();
    expect(response.status).toBe(502);
    expect(response.headers.get(RELAY_STATUS_HEADER)).toBeNull();
    expect(response.headers.get(RELAY_ERROR_HEADER)).toBe('upstream_encoding_unsupported');
  });

  test('an explicit identity content-encoding is fine', async () => {
    upstreamHeaders = [
      ['content-type', 'application/json'],
      ['content-encoding', 'identity'],
    ];
    const response = await relay();
    expect(response.status).toBe(200);
    expect(response.headers.get(RELAY_STATUS_HEADER)).not.toBeNull();
  });
});

describe('framing', () => {
  test('a small body of known length is sent with an EXACT content-length', async () => {
    const body = JSON.stringify({ token: HANDLE });
    await relay({ meta: meta({ body: { present: true, length: body.length } }), body });
    // Substitution changed the length; the header must state the POST-substitution
    // size, never the guest's.
    expect(upstreamCalls[0]?.headers['content-length']).toBe(
      String(JSON.stringify({ token: SECRET_VALUE }).length),
    );
  });

  test('a large body is streamed with NO content-length', async () => {
    const body = 'y'.repeat(70_000);
    await relay({ meta: meta({ body: { present: true, length: body.length } }), body });
    expect(upstreamCalls[0]?.headers['content-length']).toBeUndefined();
  });

  test('a bodyless request sends no body and no length header', async () => {
    await relay({ meta: meta({ method: 'GET', body: { present: false } }) });
    expect(upstreamCalls[0]?.body.byteLength).toBe(0);
    expect(upstreamCalls[0]?.headers['content-length']).toBeUndefined();
  });

  test('the guest cannot set framing headers itself', async () => {
    const response = await relay({
      meta: meta({ headers: [['transfer-encoding', 'chunked']] }),
    });
    expect(response.status).toBe(400);
    expect(response.headers.get(RELAY_ERROR_HEADER)).toBe('invalid_request');
  });

  test('accept-encoding is forced to identity so an echo cannot hide in gzip', async () => {
    await relay({ meta: meta({ headers: [['accept-encoding', 'gzip, br']] }) });
    expect(upstreamCalls[0]?.headers['accept-encoding']).toBe('identity');
  });
});

describe('the kill switch', () => {
  test('with the relay disabled every call is 503 relay_disabled', async () => {
    const original = config.KORTIX_SECRET_RELAY_STREAM_ENABLED;
    (config as { KORTIX_SECRET_RELAY_STREAM_ENABLED: boolean }).KORTIX_SECRET_RELAY_STREAM_ENABLED =
      false;
    try {
      const response = await relay();
      expect(response.status).toBe(503);
      expect(response.headers.get(RELAY_ERROR_HEADER)).toBe('relay_disabled');
      expect(await response.json()).toMatchObject({ code: 'relay_disabled' });
      // And the probe fails too, which is what puts a NEW shim in legacy mode.
      const probe = await relay({ meta: null, headers: { [RELAY_PROBE_HEADER]: '1' } });
      expect(probe.status).toBe(503);
    } finally {
      (config as { KORTIX_SECRET_RELAY_STREAM_ENABLED: boolean }).KORTIX_SECRET_RELAY_STREAM_ENABLED =
        original;
    }
  });
});

describe('redirects', () => {
  test('a 3xx after a secret rode out is refused, as on the buffered path', async () => {
    upstreamStatus = 302;
    upstreamHeaders = [['location', 'https://evil.example.com/']];
    const response = await relay({ meta: meta({ headers: [['authorization', `Bearer ${HANDLE}`]] }) });
    expect(response.status).toBe(502);
    expect(response.headers.get(RELAY_ERROR_HEADER)).toBe('upstream_failed');
  });

  test('a replayable 3xx IS followed, and the new host is re-matched', async () => {
    // The buffered /broker route follows up to 3 redirects when no credential
    // is on the wire. The relay must not silently lose that for the ordinary
    // bodyless GET, or a shim in relay mode breaks traffic that worked before.
    upstreamScript = [
      { status: 302, headers: [['location', 'https://api.example.com/v1/moved']] },
      { status: 200, headers: [['content-type', 'application/json']] },
    ];
    const response = await relay({ meta: meta({ method: 'GET', body: { present: false } }) });
    expect(response.status).toBe(200);
    expect(decodeRelayStatus(response.headers.get(RELAY_STATUS_HEADER)!).status).toBe(200);
    expect(upstreamCalls).toHaveLength(2);
    expect(upstreamCalls[1]?.url).toBe('https://api.example.com/v1/moved');
  });

  test('a redirect to an OFF-POLICY host is refused, not followed', async () => {
    // The reason the hop loop re-enters the full head gate instead of just
    // swapping the URL.
    upstreamScript = [
      { status: 302, headers: [['location', 'https://evil.example.com/v1/steal']] },
    ];
    const response = await relay({ meta: meta({ method: 'GET', body: { present: false } }) });
    expect(response.status).toBe(403);
    expect(response.headers.get(RELAY_ERROR_HEADER)).toBe('policy_denied');
    expect(upstreamCalls).toHaveLength(1);
  });

  test('a redirect LOOP stops at the limit instead of spinning', async () => {
    upstreamScript = Array.from({ length: 8 }, () => ({
      status: 302 as const,
      headers: [['location', 'https://api.example.com/v1/loop']] as Array<[string, string]>,
    }));
    const response = await relay({ meta: meta({ method: 'GET', body: { present: false } }) });
    expect(response.status).toBe(502);
    expect(upstreamCalls.length).toBeLessThanOrEqual(5);
  });

  test('a 303 rewrites the follow-up to a bodyless GET', async () => {
    const body = JSON.stringify({ plain: 'no handle here' });
    upstreamScript = [
      { status: 303, headers: [['location', 'https://api.example.com/v1/result']] },
      { status: 200, headers: [['content-type', 'application/json']] },
    ];
    await relay({ meta: meta({ body: { present: true, length: body.length } }), body });
    expect(upstreamCalls[1]?.method).toBe('GET');
    expect(upstreamCalls[1]?.body.byteLength).toBe(0);
    expect(upstreamCalls[1]?.headers['content-length']).toBeUndefined();
  });

  test('a 3xx on a STREAMED body is refused with redirect_not_replayable', async () => {
    upstreamStatus = 302;
    upstreamHeaders = [['location', 'https://api.example.com/v1/other']];
    const body = 'z'.repeat(70_000);
    const response = await relay({
      meta: meta({ body: { present: true, length: body.length } }),
      body,
    });
    expect(response.status).toBe(502);
    expect(response.headers.get(RELAY_ERROR_HEADER)).toBe('redirect_not_replayable');
  });
});

describe('the audit trail names the transport', () => {
  test('a successful relay records requested + completed', async () => {
    await relay();
    expect(audits.map((event) => event.action)).toEqual([
      'secret.broker.requested',
      'secret.broker.completed',
    ]);
    expect(audits[0]?.metadata).toMatchObject({ identifier: 'PRIMARY', transport: 'relay' });
  });

  test('no audit row ever contains the secret value', async () => {
    upstreamBody = [`{"echo":"${SECRET_VALUE}"}`];
    const response = await relay({ meta: meta({ headers: [['authorization', `Bearer ${HANDLE}`]] }) });
    await response.text();
    expect(JSON.stringify(audits)).not.toContain(SECRET_VALUE);
    expect(JSON.stringify(audits)).not.toContain(HANDLE);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// REGRESSIONS — each of these failed before the fix beside it.
// ═══════════════════════════════════════════════════════════════════════════

describe('the declared body length is never trusted as a size guarantee', () => {
  // The buffered CASE-3 branch selected itself on `meta.body.length` and then
  // read the WHOLE body with `new Response(rawBody).arrayBuffer()`. Nothing
  // compared the declaration against the bytes that actually arrived, and
  // `KORTIX_RELAY_MAX_REQUEST_BYTES` is enforced by counters inside
  // `openUpstream`, which run AFTER the buffer is materialised. Measured on bun
  // 1.3.14: `Bun.serve` applies no `maxRequestBodySize` to a chunked request
  // body, and this route is exempt from both the request deadline and Bun's
  // per-request timeout — so `{length: 1}` + a multi-GiB body was an unbounded
  // allocation with unlimited time, i.e. a one-request OOM of a shared pod.
  test('a body larger than its declared length is refused with 413, before the upstream', async () => {
    const body = 'x'.repeat(200_000);
    const response = await relay({
      meta: meta({ body: { present: true, length: 1 } }),
      body,
    });
    expect(response.status).toBe(413);
    expect(response.headers.get(RELAY_ERROR_HEADER)).toBe('relay_request_too_large');
    expect(upstreamCalls).toEqual([]);
  });

  test('the refusal is audited as a failure, not silently dropped', async () => {
    await relay({ meta: meta({ body: { present: true, length: 4 } }), body: 'x'.repeat(9_000) });
    expect(audits.map((event) => event.action)).toEqual([
      'secret.broker.requested',
      'secret.broker.failed',
    ]);
    expect(audits[1]?.after).toMatchObject({ reason: 'relay_request_too_large' });
  });

  test('an honest declaration still takes the buffered exact-length path', async () => {
    const body = JSON.stringify({ token: HANDLE });
    const response = await relay({
      meta: meta({ body: { present: true, length: body.length } }),
      body,
    });
    expect(response.status).toBe(200);
    expect(upstreamCalls[0]?.body.toString()).toBe(JSON.stringify({ token: SECRET_VALUE }));
  });
});

describe('the end-of-stream sentinel — truncation is signalled POSITIVELY', () => {
  // The route used to claim "a failure after the headers terminates the chunked
  // response without its final 0\r\n\r\n, so a missing terminator IS the error
  // signal". Measured false on bun 1.3.14 across four shapes (source Readable
  // destroyed with an error, controller.error(), pull() throwing, a declared
  // content-length cut short): Bun ALWAYS writes `0\r\n\r\n` and the client's
  // fetch resolves cleanly. So the signal is now a random per-response sentinel
  // appended ONLY on a clean flush.
  test('a completing relay ends with the sentinel named in the status header', async () => {
    upstreamBody = ['{"a":1}', '{"b":2}'];
    const response = await relay({ meta: meta({ eos: true }) });
    const status = decodeRelayStatus(response.headers.get(RELAY_STATUS_HEADER)!);
    expect(status.eos).toMatch(/^[0-9a-f]{64}$/);
    const bytes = Buffer.from(await response.arrayBuffer());
    const sentinel = Buffer.from(status.eos!, 'hex');
    expect(bytes.subarray(bytes.byteLength - sentinel.byteLength)).toEqual(sentinel);
    expect(bytes.subarray(0, bytes.byteLength - sentinel.byteLength).toString()).toBe(
      '{"a":1}{"b":2}',
    );
  });

  test('a client that does NOT ask gets no sentinel and no trailing bytes', async () => {
    // An already-baked daemon would hand the sentinel to the guest as garbage.
    upstreamBody = ['{"a":1}'];
    const response = await relay();
    const status = decodeRelayStatus(response.headers.get(RELAY_STATUS_HEADER)!);
    expect(status.eos).toBeUndefined();
    expect(await response.text()).toBe('{"a":1}');
  });

  test('an upstream that dies mid-body omits the sentinel', async () => {
    upstreamFailAfter = 1;
    upstreamBody = ['{"partial":'];
    const response = await relay({ meta: meta({ eos: true }) });
    const status = decodeRelayStatus(response.headers.get(RELAY_STATUS_HEADER)!);
    const bytes = Buffer.from(await response.arrayBuffer().catch(() => new ArrayBuffer(0)));
    const sentinel = Buffer.from(status.eos!, 'hex');
    expect(bytes.includes(sentinel)).toBe(false);
  });
});

describe('the audit trail is truthful about a STREAMED substitution', () => {
  // `secret.broker.completed` reported `hop.applied`, which only ever fills on
  // the buffered branch. A handle substituted inside a streamed body produced a
  // row with NO `substituted` key at all — an operator reconstructing which
  // credentials left the platform read it as "nothing was spent".
  test('a streamed body that substitutes is never recorded as substituting nothing', async () => {
    const body = `${'p'.repeat(70_000)}${HANDLE}${'q'.repeat(10)}`;
    const response = await relay({
      meta: meta({ body: { present: true, length: null }, eos: true }),
      body,
    });
    await response.arrayBuffer();
    expect(upstreamCalls[0]?.body.toString()).toContain(SECRET_VALUE);

    const completed = audits.find((event) => event.action === 'secret.broker.completed');
    expect(completed?.after).toMatchObject({
      substitution: 'streamed_superset',
      substitution_candidates: ['PRIMARY'],
    });

    // The EXACT set lands on the terminal row, once the body has actually run
    // through the substituter.
    const streamed = audits.find((event) => event.action === 'secret.broker.streamed');
    expect(streamed?.after).toMatchObject({ complete: true, substituted: ['PRIMARY'] });
  });
});

describe('a handle presented in a STREAMED body is still classified', () => {
  // The refusal classifier was fed `bufferedBody`, which is non-null on the
  // buffered branch ALONE. Both streaming branches left the body unscanned —
  // and the attacker picks the branch, by declaring `body.length: null` or by
  // targeting a host for which it holds no admitted handle (which makes the
  // pass-through branch fire). A live credential-theft probe was therefore
  // indistinguishable from ordinary traffic in the audit trail, while the same
  // probe through /broker was recorded. Substitution was fail-closed the whole
  // time; the forensic line was not.
  const FORGED = mintHandle({ lookupId: 'bbbbbbbbbbbbbbbbbbbb', prefix: null, rootSecret: 'a-different-root-secret' });

  test('a forged handle in a length-less (streamed) body is audited', async () => {
    const body = `{"probe":"${FORGED}"}`;
    const response = await relay({
      meta: meta({ body: { present: true, length: null } }),
      body,
    });
    await response.arrayBuffer();
    const refused = audits.find((event) => event.action === 'secret.handle.refused');
    expect(refused?.after).toMatchObject({
      surface: 'request_body',
      refusals: { forged: 1, stolen: 0, host_denied: 0 },
    });
  });

  // NOT covered here: the pass-through branch (CASE 2). Reaching it needs an
  // authorized relay with an EMPTY spendable-handle set, and
  // `authorizeSecretRelay` refuses that shape with a 409 before the route runs
  // — so it is not constructible in this harness. The tap is the same helper
  // with the same callback on both branches.
  test('an ordinary body writes no refusal row', async () => {
    const body = JSON.stringify({ hello: 'world' });
    const response = await relay({
      meta: meta({ body: { present: true, length: null } }),
      body,
    });
    await response.arrayBuffer();
    expect(audits.some((event) => event.action === 'secret.handle.refused')).toBe(false);
  });
});

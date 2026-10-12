// Per-sandbox origin routing in shared/platinum.ts. A call about one sandbox
// goes to the control plane Platinum names as its owner (`x-pt-served-by` on a
// forwarded response, `api_url` in a sandbox body) instead of paying the home
// control plane's discovery GET + forward on every call. The Bearer key must
// never follow an origin outside the configured host's domain.
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';

let mockPlatinumApiUrl = 'https://api.platinum.dev';

// The getter sits on the field: platinum.ts binds `config` once at import.
mock.module('../config', () => ({
  config: {
    PLATINUM_API_KEY: 'pt_test_key',
    get PLATINUM_API_URL() {
      return mockPlatinumApiUrl;
    },
  },
}));

const {
  acceptedPlatinumOrigin,
  platinumJson,
  platinumOriginForSandbox,
  platinumOriginForRegion,
  platinumRegionControlPlane,
  PlatinumSandboxNotRunningError,
  PLATINUM_ORIGIN_CACHE_MAX,
  __resetPlatinumSandboxOriginsForTests,
} = await import('./platinum');

const US = 'https://us-east.api.platinum.dev';
const GLOBAL = 'https://api.platinum.dev';

type Call = { url: string; method: string; auth: string | null };
// Compare the parsed origin, never a URL prefix: a prefix also matches `https://host.evil`.
const onOrigin = (call: Call, origin: string): boolean => new URL(call.url).origin === origin;

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> } | Error;

const originalFetch = globalThis.fetch;
let calls: Call[] = [];
let respond: (call: Call) => Reply = () => ({ body: {} });

function stubFetch(): void {
  const handler = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call = {
      url: String(input),
      method: init?.method ?? 'GET',
      auth: headers.Authorization ?? null,
    };
    calls.push(call);
    const reply = respond(call);
    if (reply instanceof Error) throw reply;
    return new Response(reply.body === undefined ? '' : JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { 'Content-Type': 'application/json', ...(reply.headers ?? {}) },
    });
  };
  globalThis.fetch = Object.assign(handler, { preconnect: () => {} }) as typeof fetch;
}

function networkError(code: string): Error {
  return Object.assign(new Error(`network failure ${code}`), { code });
}

beforeEach(() => {
  mockPlatinumApiUrl = GLOBAL;
  calls = [];
  respond = () => ({ body: {} });
  __resetPlatinumSandboxOriginsForTests();
  stubFetch();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('a forwarded answer names the owner, and the next call for that id goes straight to it', async () => {
  respond = (call) =>
    onOrigin(call, GLOBAL)
      ? { body: { id: 'sbx_us', state: 'running' }, headers: { 'x-pt-served-by': US } }
      : { body: { result: { exit_code: 0 } } };

  await platinumJson('/v1/sandboxes/sbx_us');
  await platinumJson('/v1/sandboxes/sbx_us/exec', { method: 'POST', body: '{"cmd":["true"]}' });
  await platinumJson('/v1/sandboxes/sbx_other');
  await platinumJson('/v1/sandboxes?paginated=true&limit=100&offset=0');

  expect(calls.map((c) => c.url)).toEqual([
    `${GLOBAL}/v1/sandboxes/sbx_us`,
    `${US}/v1/sandboxes/sbx_us/exec`,
    `${GLOBAL}/v1/sandboxes/sbx_other`,
    `${GLOBAL}/v1/sandboxes?paginated=true&limit=100&offset=0`,
  ]);
  expect(calls.every((c) => c.auth === 'Bearer pt_test_key')).toBe(true);
});

test('a sandbox body teaches its api_url, but only for the id it describes', async () => {
  respond = (call) => {
    if (call.url.endsWith('/v1/sandboxes/sbx_us')) return { body: { id: 'sbx_us', api_url: US } };
    if (call.url.endsWith('/v1/sandboxes/sbx_mismatch'))
      return { body: { id: 'sbx_us_other', api_url: US } };
    return { body: {} };
  };

  await platinumJson('/v1/sandboxes/sbx_us');
  await platinumJson('/v1/sandboxes/sbx_mismatch');

  expect(platinumOriginForSandbox('sbx_us')).toBe(US);
  expect(platinumOriginForSandbox('sbx_mismatch')).toBe(GLOBAL);
  expect(platinumOriginForSandbox('sbx_us_other')).toBe(GLOBAL);
});

test('a create answer records the new box owner, so its first call by id is direct', async () => {
  respond = (call) =>
    call.method === 'POST' && call.url.includes('/v1/sandboxes?')
      ? { status: 201, body: { id: 'sbx_new', state: 'running', region: 'us-east', api_url: US } }
      : { body: { id: 'sbx_new', state: 'running' } };

  await platinumJson('/v1/sandboxes?wait_for_state=running&wait_timeout_ms=60000', {
    method: 'POST',
    body: JSON.stringify({ template: 'tpl_x', region: 'us-east' }),
  });
  await platinumJson('/v1/sandboxes/sbx_new/expose', { method: 'POST', body: '{"port":8000}' });

  expect(calls.map((c) => c.url)).toEqual([
    `${GLOBAL}/v1/sandboxes?wait_for_state=running&wait_timeout_ms=60000`,
    `${US}/v1/sandboxes/sbx_new/expose`,
  ]);
});

test.each([
  ['https://evil.example'],
  ['http://us-east.api.platinum.dev'],
  ['https://api.platinum.dev.evil.com'],
  ['https://evilapi.platinum.dev'],
  ['https://us-east.api.platinum.dev:8443'],
  ['https://user:pass@us-east.api.platinum.dev'],
  ['https://us-east.api.platinum.dev/v1'],
  ['https://us-east.api.platinum.dev/?x=1'],
  ['not a url'],
])('refuses to send the key to %s', async (candidate) => {
  expect(acceptedPlatinumOrigin(candidate)).toBeNull();

  respond = () => ({
    body: { id: 'sbx_us', api_url: candidate },
    headers: { 'x-pt-served-by': candidate },
  });
  await platinumJson('/v1/sandboxes/sbx_us');
  await platinumJson('/v1/sandboxes/sbx_us/exec', { method: 'POST', body: '{}' });

  expect(calls.map((c) => new URL(c.url).origin)).toEqual([GLOBAL, GLOBAL]);
  expect(platinumOriginForSandbox('sbx_us')).toBe(GLOBAL);
});

test('accepts the configured origin and https subdomains of its host', () => {
  expect(acceptedPlatinumOrigin(US)).toBe(US);
  expect(acceptedPlatinumOrigin(`${US}/`)).toBe(US);
  expect(acceptedPlatinumOrigin(GLOBAL)).toBe(GLOBAL);
  expect(acceptedPlatinumOrigin(undefined)).toBeNull();
  expect(acceptedPlatinumOrigin('')).toBeNull();
});

test('an unreachable owner is forgotten and the call is sent once via the global origin', async () => {
  respond = (call) => {
    if (call.url === `${GLOBAL}/v1/sandboxes/sbx_us`)
      return { body: { id: 'sbx_us', api_url: US } };
    if (onOrigin(call, US)) return networkError('ConnectionRefused');
    return { body: { result: { exit_code: 0 } } };
  };
  await platinumJson('/v1/sandboxes/sbx_us');
  calls = [];
  // The global origin answers this one without naming the owner again.
  respond = (call) =>
    onOrigin(call, US)
      ? networkError('ConnectionRefused')
      : { body: { result: { exit_code: 0 } } };

  await platinumJson('/v1/sandboxes/sbx_us/exec', { method: 'POST', body: '{}' });
  await platinumJson('/v1/sandboxes/sbx_us/exec', { method: 'POST', body: '{}' });

  expect(calls.map((c) => c.url)).toEqual([
    `${US}/v1/sandboxes/sbx_us/exec`,
    `${GLOBAL}/v1/sandboxes/sbx_us/exec`,
    `${GLOBAL}/v1/sandboxes/sbx_us/exec`,
  ]);
  expect(platinumOriginForSandbox('sbx_us')).toBe(GLOBAL);
});

test('a write that may have reached the owner is not sent twice; a read is', async () => {
  respond = () => ({ body: { id: 'sbx_us', api_url: US } });
  await platinumJson('/v1/sandboxes/sbx_us');
  calls = [];
  respond = (call) =>
    onOrigin(call, US) ? networkError('ECONNRESET') : { body: { id: 'sbx_us', api_url: US } };

  await expect(
    platinumJson('/v1/sandboxes/sbx_us/exec', { method: 'POST', body: '{}' }),
  ).rejects.toThrow(/ECONNRESET/);
  expect(calls.map((c) => c.url)).toEqual([`${US}/v1/sandboxes/sbx_us/exec`]);

  calls = [];
  await platinumJson('/v1/sandboxes/sbx_us');
  expect(calls.map((c) => c.url)).toEqual([
    `${US}/v1/sandboxes/sbx_us`,
    `${GLOBAL}/v1/sandboxes/sbx_us`,
  ]);
});

test('a timeout against the owner is not retried and keeps its message', async () => {
  respond = () => ({ body: { id: 'sbx_us', api_url: US } });
  await platinumJson('/v1/sandboxes/sbx_us');
  calls = [];
  respond = () => Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' });

  await expect(platinumJson('/v1/sandboxes/sbx_us')).rejects.toThrow(
    /platinum GET \/v1\/sandboxes\/sbx_us timed out after \d+ms \(default\)/,
  );
  expect(calls.map((c) => c.url)).toEqual([`${US}/v1/sandboxes/sbx_us`]);
});

test('a stopped box still raises the typed error when its owner answers', async () => {
  respond = () => ({ body: { id: 'sbx_us', api_url: US } });
  await platinumJson('/v1/sandboxes/sbx_us');
  respond = () => ({
    status: 409,
    body: { error: 'sandbox not running', code: 'sandbox_not_running' },
  });

  const err = await platinumJson('/v1/sandboxes/sbx_us/expose', {
    method: 'POST',
    body: '{}',
  }).catch((e) => e);
  expect(err).toBeInstanceOf(PlatinumSandboxNotRunningError);
  expect(calls.at(-1)?.url).toBe(`${US}/v1/sandboxes/sbx_us/expose`);
});

test('an owner named by an error answer is learned too', async () => {
  respond = () => ({
    status: 409,
    body: { code: 'sandbox_not_running' },
    headers: { 'x-pt-served-by': US },
  });
  await platinumJson('/v1/sandboxes/sbx_us/expose', { method: 'POST', body: '{}' }).catch(
    () => undefined,
  );
  expect(platinumOriginForSandbox('sbx_us')).toBe(US);
});

test('a single-region deployment changes nothing', async () => {
  mockPlatinumApiUrl = 'https://api-dev.platinum.dev';
  respond = () => ({
    body: { id: 'sbx_dev', api_url: 'https://api-dev.platinum.dev' },
    headers: { 'x-pt-served-by': 'https://api-dev.platinum.dev' },
  });

  await platinumJson('/v1/sandboxes/sbx_dev');
  await platinumJson('/v1/sandboxes/sbx_dev/exec', { method: 'POST', body: '{}' });

  expect(calls.map((c) => c.url)).toEqual([
    'https://api-dev.platinum.dev/v1/sandboxes/sbx_dev',
    'https://api-dev.platinum.dev/v1/sandboxes/sbx_dev/exec',
  ]);
  // A US origin is not a subdomain of the dev host: never trusted there.
  expect(acceptedPlatinumOrigin(US)).toBeNull();
});

test('a box moved home again goes back to the global origin', async () => {
  respond = () => ({ body: { id: 'sbx_moved', api_url: US } });
  await platinumJson('/v1/sandboxes/sbx_moved');
  respond = () => ({ body: { id: 'sbx_moved', api_url: GLOBAL } });
  await platinumJson('/v1/sandboxes/sbx_moved');
  expect(platinumOriginForSandbox('sbx_moved')).toBe(GLOBAL);
});

test('the origin cache is bounded and drops the oldest entry first', async () => {
  respond = (call) => {
    const id = call.url.split('/').pop() ?? '';
    return { body: { id, api_url: US } };
  };
  for (let i = 0; i <= PLATINUM_ORIGIN_CACHE_MAX; i++) await platinumJson(`/v1/sandboxes/sbx_${i}`);

  expect(platinumOriginForSandbox('sbx_0')).toBe(GLOBAL);
  expect(platinumOriginForSandbox('sbx_1')).toBe(US);
  expect(platinumOriginForSandbox(`sbx_${PLATINUM_ORIGIN_CACHE_MAX}`)).toBe(US);
});


test('a create for a region this process has already seen goes straight to that region', async () => {
  respond = (call) => {
    if (call.method === 'GET') return { body: { id: 'sbx_seen', state: 'running', region: 'us-east', api_url: US } };
    return { status: 201, body: { id: 'sbx_next', state: 'running', region: 'us-east', api_url: US } };
  };

  await platinumJson('/v1/sandboxes/sbx_seen');
  expect(platinumOriginForRegion('us-east')).toBe(US);
  await platinumJson('/v1/sandboxes?wait_for_state=running', {
    method: 'POST',
    body: JSON.stringify({ template: 'tpl_x', region: 'us-east' }),
  });
  // No region asked for → the home region, through the global origin as before.
  await platinumJson('/v1/sandboxes?wait_for_state=running', {
    method: 'POST',
    body: JSON.stringify({ template: 'tpl_x' }),
  });
  // A region nothing has taught yet → global, which forwards.
  await platinumJson('/v1/sandboxes?wait_for_state=running', {
    method: 'POST',
    body: JSON.stringify({ template: 'tpl_x', region: 'ap-south' }),
  });

  expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
    `GET ${GLOBAL}/v1/sandboxes/sbx_seen`,
    `POST ${US}/v1/sandboxes?wait_for_state=running`,
    `POST ${GLOBAL}/v1/sandboxes?wait_for_state=running`,
    `POST ${GLOBAL}/v1/sandboxes?wait_for_state=running`,
  ]);
});

test('a home-region box teaches nothing, and a foreign api_url never becomes a region origin', async () => {
  respond = (call) => {
    if (call.url.endsWith('/sbx_eu')) return { body: { id: 'sbx_eu', region: 'eu-west', api_url: GLOBAL } };
    if (call.url.endsWith('/sbx_evil')) return { body: { id: 'sbx_evil', region: 'us-east', api_url: 'https://evil.example' } };
    return { body: {} };
  };
  await platinumJson('/v1/sandboxes/sbx_eu');
  await platinumJson('/v1/sandboxes/sbx_evil');
  expect(platinumOriginForRegion('eu-west')).toBe(GLOBAL);
  expect(platinumOriginForRegion('us-east')).toBe(GLOBAL);
});

test('a regional create whose connection never opened retries once via global and forgets the region', async () => {
  let first = true;
  respond = (call) => {
    if (call.method === 'GET') return { body: { id: 'sbx_seen', region: 'us-east', api_url: US } };
    if (onOrigin(call, US) && first) {
      first = false;
      return networkError('ConnectionRefused');
    }
    return { status: 201, body: { id: 'sbx_new', region: 'us-east', api_url: US } };
  };
  await platinumJson('/v1/sandboxes/sbx_seen');
  await platinumJson('/v1/sandboxes', { method: 'POST', body: JSON.stringify({ template: 't', region: 'us-east' }) });
  expect(calls.slice(1).map((c) => c.url)).toEqual([`${US}/v1/sandboxes`, `${GLOBAL}/v1/sandboxes`]);
});

test('a regional create reset mid-request is never sent twice', async () => {
  respond = (call) => {
    if (call.method === 'GET') return { body: { id: 'sbx_seen', region: 'us-east', api_url: US } };
    return networkError('ECONNRESET');
  };
  await platinumJson('/v1/sandboxes/sbx_seen');
  await expect(
    platinumJson('/v1/sandboxes', { method: 'POST', body: JSON.stringify({ template: 't', region: 'us-east' }) }),
  ).rejects.toThrow();
  expect(calls.slice(1).map((c) => c.url)).toEqual([`${US}/v1/sandboxes`]);
});

test("a region's control plane is its regional name under the configured host, and a listing goes only there", async () => {
  expect(platinumRegionControlPlane('us-east')).toBe(US);
  expect(platinumRegionControlPlane('../evil')).toBeNull();
  await platinumJson('/v1/sandboxes?paginated=true&regions=local&limit=200&offset=0', {}, US);
  expect(calls.map((c) => c.url)).toEqual([`${US}/v1/sandboxes?paginated=true&regions=local&limit=200&offset=0`]);
  expect(calls[0]!.auth).toBe('Bearer pt_test_key');
  // A host with no subdomain form (a local control plane) gets no regional origin.
  mockPlatinumApiUrl = 'http://127.0.0.1:9000';
  expect(platinumRegionControlPlane('us-east')).toBeNull();
});

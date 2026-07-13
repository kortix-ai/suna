import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { isPrivateIp, UnsafeEgressError, assertSafeEgressUrl, safeEgressFetch } from '../shared/ssrf-guard';

// `node:dns/promises` is mocked per-test below so no real network DNS happens.
let dnsResults: Record<string, Array<{ address: string; family: number }>> = {};
const dnsErrors: Record<string, Error> = {};
mock.module('node:dns/promises', () => ({
  lookup: async (host: string, _opts: unknown) => {
    if (dnsErrors[host]) throw dnsErrors[host];
    return dnsResults[host] ?? [];
  },
}));

let fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
let fetchResponses: Array<{ status: number; headers?: Record<string, string>; body?: string }> = [];
const realFetch = globalThis.fetch;
beforeEach(() => {
  dnsResults = {};
  for (const k of Object.keys(dnsErrors)) delete dnsErrors[k];
  fetchCalls = [];
  fetchResponses = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), init });
    const r = fetchResponses.shift() ?? { status: 200, body: 'ok' };
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      statusText: r.status === 200 ? 'OK' : 'ERR',
      headers: new Headers(r.headers ?? {}),
      text: async () => r.body ?? '',
      json: async () => JSON.parse(r.body ?? '{}'),
    } as unknown as Response;
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('isPrivateIp', () => {
  const cases: Array<[string, boolean]> = [
    // IPv4 private / reserved
    ['127.0.0.1', true],
    ['127.255.255.255', true],
    ['0.0.0.0', true],
    ['10.0.0.1', true],
    ['192.168.1.1', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['169.254.169.254', true], // cloud metadata
    ['100.64.0.1', true], // CGNAT 100.64/10 — not public-routable
    ['100.63.0.1', false], // just below CGNAT
    ['100.128.0.1', false], // just above CGNAT
    ['224.0.0.1', true], // multicast
    ['8.8.8.8', false],
    ['1.1.1.1', false],
    ['172.15.0.1', false], // just below 172.16/12
    ['172.32.0.1', false], // just above
    // IPv6
    ['::1', true],
    ['::', true],
    ['fc00::1', true], // ULA
    ['fd00:ec2::254', true], // AWS IPv6 metadata
    ['fe80::1', true], // link-local
    ['ff02::1', true], // multicast
    ['2001:4860:4860::8888', false], // Google DNS v6
    // IPv4-mapped IPv6 → unwrapped and checked as v4
    ['::ffff:127.0.0.1', true],
    ['::ffff:169.254.169.254', true],
    ['::ffff:8.8.8.8', false],
    ['not-an-ip', true], // non-IP → unsafe (defensive)
    ['', true],
  ];
  for (const [ip, expectedPrivate] of cases) {
    test(`${ip} → ${expectedPrivate ? 'private' : 'public'}`, () => {
      expect(isPrivateIp(ip)).toBe(expectedPrivate);
    });
  }
});

describe('assertSafeEgressUrl', () => {
  test('rejects non-https', async () => {
    await expect(assertSafeEgressUrl('http://example.com/x')).rejects.toBeInstanceOf(UnsafeEgressError);
  });
  test('rejects userinfo', async () => {
    dnsResults['example.com'] = [{ address: '93.184.216.34', family: 4 }];
    await expect(assertSafeEgressUrl('https://user:pass@example.com/x')).rejects.toBeInstanceOf(
      UnsafeEgressError,
    );
  });
  test('rejects a literal private IP host', async () => {
    await expect(assertSafeEgressUrl('https://169.254.169.254/latest/meta-data/')).rejects.toBeInstanceOf(
      UnsafeEgressError,
    );
    await expect(assertSafeEgressUrl('https://127.0.0.1/')).rejects.toBeInstanceOf(UnsafeEgressError);
    await expect(assertSafeEgressUrl('https://10.0.0.5/')).rejects.toBeInstanceOf(UnsafeEgressError);
    // No DNS lookup should have happened for literal IPs.
    expect(fetchCalls).toHaveLength(0);
  });
  test('rejects a public hostname that DNS-resolves to a private IP (DNS-rebind)', async () => {
    dnsResults['rebind.evil'] = [{ address: '169.254.169.254', family: 4 }];
    await expect(assertSafeEgressUrl('https://rebind.evil/latest/meta-data/')).rejects.toBeInstanceOf(
      UnsafeEgressError,
    );
  });
  test('rejects if ANY resolved address is private (mixed A record)', async () => {
    dnsResults['mixed.evil'] = [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ];
    await expect(assertSafeEgressUrl('https://mixed.evil/x')).rejects.toBeInstanceOf(UnsafeEgressError);
  });
  test('accepts a public hostname resolving to public IPs', async () => {
    dnsResults['example.com'] = [{ address: '93.184.216.34', family: 4 }];
    const u = await assertSafeEgressUrl('https://example.com/x');
    expect(u.hostname).toBe('example.com');
  });
  test('rejects when DNS resolution fails', async () => {
    dnsErrors['nope.evil'] = new Error('ENOTFOUND');
    await expect(assertSafeEgressUrl('https://nope.evil/x')).rejects.toBeInstanceOf(UnsafeEgressError);
  });
  test('allowHttp permits http:', async () => {
    dnsResults['internal.example'] = [{ address: '93.184.216.34', family: 4 }];
    const u = await assertSafeEgressUrl('http://internal.example/x', { allowHttp: true });
    expect(u.protocol).toBe('http:');
  });
});

describe('safeEgressFetch', () => {
  test('fetches a validated public URL and returns the response', async () => {
    dnsResults['example.com'] = [{ address: '93.184.216.34', family: 4 }];
    fetchResponses = [{ status: 200, body: 'hello' }];
    const res = await safeEgressFetch('https://example.com/x');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hello');
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].init?.redirect).toBe('manual');
  });
  test('blocks the fetch entirely when the host resolves to a private IP (no fetch issued)', async () => {
    dnsResults['rebind.evil'] = [{ address: '169.254.169.254', family: 4 }];
    await expect(safeEgressFetch('https://rebind.evil/x')).rejects.toBeInstanceOf(UnsafeEgressError);
    expect(fetchCalls).toHaveLength(0);
  });
  test('follows a redirect to a public host with re-validation', async () => {
    dnsResults['a.example'] = [{ address: '93.184.216.34', family: 4 }];
    dnsResults['b.example'] = [{ address: '93.184.216.35', family: 4 }];
    fetchResponses = [
      { status: 302, headers: { location: 'https://b.example/dest' } },
      { status: 200, body: 'arrived' },
    ];
    const res = await safeEgressFetch('https://a.example/start');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('arrived');
    expect(fetchCalls.map((c) => c.url)).toEqual([
      'https://a.example/start',
      'https://b.example/dest',
    ]);
  });
  test('blocks a redirect to a private IP host', async () => {
    dnsResults['a.example'] = [{ address: '93.184.216.34', family: 4 }];
    dnsResults['rebind.evil'] = [{ address: '169.254.169.254', family: 4 }];
    fetchResponses = [{ status: 302, headers: { location: 'https://rebind.evil/x' } }];
    await expect(safeEgressFetch('https://a.example/start')).rejects.toBeInstanceOf(
      UnsafeEgressError,
    );
    // First hop fetch happened, second was blocked before fetch.
    expect(fetchCalls).toHaveLength(1);
  });
  test('stops after MAX_REDIRECTS', async () => {
    dnsResults['loop.example'] = [{ address: '93.184.216.34', family: 4 }];
    fetchResponses = Array.from({ length: 7 }, () => ({
      status: 302,
      headers: { location: 'https://loop.example/next' },
    }));
    await expect(safeEgressFetch('https://loop.example/start')).rejects.toBeInstanceOf(
      UnsafeEgressError,
    );
  });
  test('propagates the caller signal to every hop', async () => {
    dnsResults['example.com'] = [{ address: '93.184.216.34', family: 4 }];
    const ac = new AbortController();
    fetchResponses = [{ status: 200, body: 'ok' }];
    await safeEgressFetch('https://example.com/x', { signal: ac.signal });
    expect((fetchCalls[0].init?.signal as AbortSignal).aborted).toBe(false);
  });
});

import { describe, expect, test } from 'bun:test';

import {
  namedTunnelConfigured,
  parseQuickTunnelUrl,
  reachabilityMode,
  resolveTunnelUrl,
} from '../tunnel.ts';

describe('reachabilityMode', () => {
  test('KORTIX_DOMAIN set always wins, regardless of KORTIX_REACHABILITY_MODE', () => {
    expect(reachabilityMode({ KORTIX_DOMAIN: 'kortix.example.com', KORTIX_REACHABILITY_MODE: 'tunnel' })).toBe('domain');
    expect(reachabilityMode({ KORTIX_DOMAIN: 'kortix.example.com', KORTIX_REACHABILITY_MODE: 'local' })).toBe('domain');
    expect(reachabilityMode({ KORTIX_DOMAIN: '  ' })).toBe('local');
  });

  test('tunnel mode requires the explicit preference, and only absent a domain', () => {
    expect(reachabilityMode({ KORTIX_REACHABILITY_MODE: 'tunnel' })).toBe('tunnel');
    expect(reachabilityMode({ KORTIX_DOMAIN: '', KORTIX_REACHABILITY_MODE: 'tunnel' })).toBe('tunnel');
  });

  test('defaults to local when nothing is configured — backward compatible with pre-feature instances', () => {
    expect(reachabilityMode({})).toBe('local');
    expect(reachabilityMode({ KORTIX_REACHABILITY_MODE: 'bogus' })).toBe('local');
  });
});

describe('namedTunnelConfigured', () => {
  test('requires BOTH a token and a hostname', () => {
    expect(namedTunnelConfigured({})).toBe(false);
    expect(namedTunnelConfigured({ CLOUDFLARE_TUNNEL_TOKEN: 'abc' })).toBe(false);
    expect(namedTunnelConfigured({ CLOUDFLARE_TUNNEL_HOSTNAME: 'kortix.example.com' })).toBe(false);
    expect(namedTunnelConfigured({ CLOUDFLARE_TUNNEL_TOKEN: 'abc', CLOUDFLARE_TUNNEL_HOSTNAME: 'kortix.example.com' })).toBe(true);
  });

  test('blank/whitespace-only values do not count as configured', () => {
    expect(namedTunnelConfigured({ CLOUDFLARE_TUNNEL_TOKEN: '  ', CLOUDFLARE_TUNNEL_HOSTNAME: 'kortix.example.com' })).toBe(false);
  });
});

describe('parseQuickTunnelUrl', () => {
  test('extracts the trycloudflare.com URL from cloudflared boot logs', () => {
    const logs = `
2026-07-15T00:00:00Z INF Thank you for trying Cloudflare Tunnel...
2026-07-15T00:00:01Z INF +--------------------------------------------------------------------------------------------+
2026-07-15T00:00:01Z INF |  https://random-words-here-example.trycloudflare.com                                        |
2026-07-15T00:00:01Z INF +--------------------------------------------------------------------------------------------+
2026-07-15T00:00:02Z INF Registered tunnel connection connIndex=0
`;
    expect(parseQuickTunnelUrl(logs)).toBe('https://random-words-here-example.trycloudflare.com');
  });

  test('returns null when no URL is present yet (still booting)', () => {
    expect(parseQuickTunnelUrl('2026-07-15T00:00:00Z INF Starting tunnel...')).toBeNull();
    expect(parseQuickTunnelUrl('')).toBeNull();
  });

  test('ignores a look-alike domain that is not actually trycloudflare.com', () => {
    expect(parseQuickTunnelUrl('https://evil-trycloudflare.com.attacker.net')).toBeNull();
  });
});

describe('resolveTunnelUrl', () => {
  test('a named tunnel resolves instantly from the hostname — no log polling', async () => {
    let readCalls = 0;
    const result = await resolveTunnelUrl(
      { CLOUDFLARE_TUNNEL_TOKEN: 'tok', CLOUDFLARE_TUNNEL_HOSTNAME: 'kortix.example.com' },
      () => { readCalls++; return ''; },
    );
    expect(result).toEqual({ ok: true, url: 'https://kortix.example.com' });
    expect(readCalls).toBe(0);
  });

  test('strips a scheme prefix if the operator pasted the hostname with one', async () => {
    const result = await resolveTunnelUrl(
      { CLOUDFLARE_TUNNEL_TOKEN: 'tok', CLOUDFLARE_TUNNEL_HOSTNAME: 'https://kortix.example.com' },
      () => '',
    );
    expect(result.url).toBe('https://kortix.example.com');
  });

  test('quick tunnel: returns the URL as soon as the logs contain it', async () => {
    const result = await resolveTunnelUrl(
      {},
      () => 'INF |  https://abc-def.trycloudflare.com  |',
      5_000,
      10,
    );
    expect(result).toEqual({ ok: true, url: 'https://abc-def.trycloudflare.com' });
  });

  test('quick tunnel: polls until the URL appears', async () => {
    let calls = 0;
    const result = await resolveTunnelUrl(
      {},
      () => {
        calls++;
        return calls < 3 ? 'INF Starting tunnel...' : 'INF |  https://late.trycloudflare.com  |';
      },
      5_000,
      1,
    );
    expect(result).toEqual({ ok: true, url: 'https://late.trycloudflare.com' });
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  test('quick tunnel: times out with an actionable error if the URL never appears', async () => {
    const result = await resolveTunnelUrl({}, () => 'INF still booting...', 30, 10);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Timed out');
    expect(result.error).toContain('cloudflared');
  });
});

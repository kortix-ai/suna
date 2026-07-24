import { describe, expect, test } from 'bun:test';
import { buildDirectPreviewUrl, parseProxiedPreviewUrl, rewriteWsUrlToUpstream } from './preview';

describe('parseProxiedPreviewUrl', () => {
  test('extracts sandbox, port, and path from a proxied preview URL', () => {
    const parsed = parseProxiedPreviewUrl('http://localhost:3010/api/kortix/p/sb_abc/3000/app?x=1');
    expect(parsed).toEqual({ sandboxId: 'sb_abc', port: 3000, path: '/app?x=1' });
  });

  test('returns null for non-proxy URLs', () => {
    expect(parseProxiedPreviewUrl('http://localhost:3010/projects/foo')).toBeNull();
  });
});

describe('buildDirectPreviewUrl', () => {
  test('rebuilds against the upstream with the scoped token', () => {
    const url = buildDirectPreviewUrl(
      'https://api.example.com/v1/',
      { sandboxId: 'sb_abc', port: 3000, path: '/app' },
      'tok123',
    );
    expect(url).toBe('https://api.example.com/v1/p/sb_abc/3000/app?token=tok123');
  });
});

describe('rewriteWsUrlToUpstream', () => {
  test('rewrites a proxied PTY socket URL to a direct upstream wss URL', () => {
    const out = rewriteWsUrlToUpstream(
      'ws://localhost:3010/api/kortix/p/sb_abc/8000/kortix/pty/pty1/connect?token=session-tok',
      'https://api.example.com/v1',
      'scoped-tok',
    );
    expect(out).toBe(
      'wss://api.example.com/v1/p/sb_abc/8000/kortix/pty/pty1/connect?token=scoped-tok',
    );
  });

  test('keeps non-token query params and maps http upstream to ws', () => {
    const out = rewriteWsUrlToUpstream(
      'wss://demo.example.com/api/kortix/p/sb_x/8000/kortix/pty/p2/connect?token=old&foo=bar',
      'http://localhost:8008/v1',
      'new-tok',
    );
    expect(out).toBe(
      'ws://localhost:8008/v1/p/sb_x/8000/kortix/pty/p2/connect?foo=bar&token=new-tok',
    );
  });

  test('returns null for URLs that are not the sandbox proxy shape', () => {
    expect(
      rewriteWsUrlToUpstream(
        'ws://localhost:3010/api/other/thing',
        'http://localhost:8008/v1',
        't',
      ),
    ).toBeNull();
  });
});

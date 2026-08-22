import { describe, expect, test } from 'bun:test';
import {
  assertSafePresignedUploadUrl,
  classifyIpHost,
  parseUploadHostAllowlist,
  sanitizeUrlForLog,
  type IpHostClass,
} from './upload-url-guard';

describe('sanitizeUrlForLog — presign signature never reaches a log', () => {
  test('strips the query string (the presign signature) and fragment', () => {
    const raw =
      'https://s3.fr-par.scw.cloud/bucket/ctx.tar.gz?X-Amz-Signature=deadbeefSECRET&X-Amz-Credential=AKIA#frag';
    expect(sanitizeUrlForLog(raw)).toBe('https://s3.fr-par.scw.cloud/bucket/ctx.tar.gz');
    expect(sanitizeUrlForLog(raw)).not.toContain('Signature');
    expect(sanitizeUrlForLog(raw)).not.toContain('SECRET');
  });

  test('defensively cuts query/fragment from a non-URL string', () => {
    expect(sanitizeUrlForLog('not a url?token=secret#x')).toBe('not a url');
  });
});

describe('classifyIpHost', () => {
  test.each([
    ['127.0.0.1', 'loopback'],
    ['127.5.5.5', 'loopback'],
    ['0.0.0.0', 'unspecified'],
    ['169.254.169.254', 'link-local'], // cloud metadata endpoint
    ['10.0.0.5', 'private'],
    ['172.16.9.9', 'private'],
    ['172.32.0.1', 'public'],
    ['192.168.1.1', 'private'],
    ['100.64.0.1', 'private'],
    ['224.0.0.1', 'multicast'],
    ['8.8.8.8', 'public'],
    ['::1', 'loopback'],
    ['fe80::1', 'link-local'],
    ['fc00::1', 'private'],
    ['fd12::1', 'private'],
    ['ff02::1', 'multicast'],
    ['::ffff:10.0.0.1', 'private'],
    ['2606:4700::1', 'public'],
    ['s3.example.com', 'not-ip'],
  ] as Array<[string, IpHostClass]>)('%s → %s', (host, expected) => {
    expect(classifyIpHost(host)).toBe(expected);
  });

  // IPv4-mapped IPv6 in the COMPRESSED HEX form Node's WHATWG URL serializer
  // emits — the form that actually reaches the guard from `new URL(...).hostname`
  // (the old dotted-only regex let every one of these fall through to `public`).
  test.each([
    ['[::ffff:a9fe:a9fe]', 'link-local'], // 169.254.169.254 — cloud metadata
    ['[::ffff:7f00:1]', 'loopback'], //     127.0.0.1
    ['[::ffff:a00:1]', 'private'], //       10.0.0.1
    ['[::ffff:c0a8:1]', 'private'], //      192.168.0.1
    ['[::ffff:0808:0808]', 'public'], //    8.8.8.8 stays public
  ] as Array<[string, IpHostClass]>)('mapped-hex %s → %s', (host, expected) => {
    expect(classifyIpHost(host)).toBe(expected);
  });

  test('classifies the EXACT hostname a parsed URL yields (not a pre-normalized string)', () => {
    // Proves the guard sees what the URL serializer actually produces.
    expect(new URL('http://[::ffff:169.254.169.254]/x').hostname).toBe('[::ffff:a9fe:a9fe]');
    expect(classifyIpHost(new URL('http://[::ffff:169.254.169.254]/x').hostname)).toBe('link-local');
    expect(classifyIpHost(new URL('http://[::ffff:127.0.0.1]/x').hostname)).toBe('loopback');
    expect(classifyIpHost(new URL('http://[::ffff:10.0.0.1]/x').hostname)).toBe('private');
    expect(classifyIpHost(new URL('http://[::ffff:192.168.0.1]/x').hostname)).toBe('private');
  });
});

describe('assertSafePresignedUploadUrl (PHASE 2)', () => {
  test('accepts a normal https object-storage URL', () => {
    const u = assertSafePresignedUploadUrl('https://s3.fr-par.scw.cloud/bucket/x.tar.gz?sig=abc');
    expect(u.hostname).toBe('s3.fr-par.scw.cloud');
  });

  test('rejects a plaintext http URL outside local-dev', () => {
    expect(() => assertSafePresignedUploadUrl('http://s3.fr-par.scw.cloud/x')).toThrow(/https/);
  });

  test('allows http on loopback in local-dev', () => {
    expect(() =>
      assertSafePresignedUploadUrl('http://127.0.0.1:9000/bucket/x', { allowLocal: true }),
    ).not.toThrow();
  });

  test.each([
    ['loopback', 'https://127.0.0.1/x'],
    ['localhost name', 'https://localhost/x'],
    ['link-local metadata', 'https://169.254.169.254/latest/meta-data'],
    ['private 10/8', 'https://10.1.2.3/x'],
    ['private 192.168', 'https://192.168.0.5/x'],
    ['ipv6 loopback', 'https://[::1]/x'],
    ['ipv6 link-local', 'https://[fe80::1]/x'],
  ])('rejects SSRF target: %s', (_label, url) => {
    expect(() => assertSafePresignedUploadUrl(url)).toThrow(/not routable|allowlist/);
  });

  // The SSRF bypass: these all serialize to compressed-hex IPv4-mapped IPv6 via
  // `new URL(...)`, so this asserts the guard rejects the REAL parsed host, not a
  // hand-written dotted string. Each targets a metadata/loopback/private address.
  test.each([
    ['mapped metadata', 'https://[::ffff:169.254.169.254]/latest/meta-data'],
    ['mapped loopback', 'https://[::ffff:127.0.0.1]/x'],
    ['mapped private 10/8', 'https://[::ffff:10.0.0.1]/x'],
    ['mapped private 192.168', 'https://[::ffff:192.168.0.1]/x'],
  ])('rejects IPv4-mapped-IPv6 SSRF target: %s', (_label, url) => {
    // Sanity: the host really is the compressed-hex form the guard must handle.
    expect(new URL(url).hostname).toMatch(/^\[::ffff:[0-9a-f]/);
    expect(() => assertSafePresignedUploadUrl(url)).toThrow(/not routable|allowlist/);
  });

  test('still accepts a genuine public https host (no false positive)', () => {
    expect(() => assertSafePresignedUploadUrl('https://s3.fr-par.scw.cloud/bucket/x?sig=abc')).not.toThrow();
    // A public IPv4-mapped IPv6 (8.8.8.8) is public and must NOT be rejected as SSRF.
    expect(classifyIpHost(new URL('http://[::ffff:8.8.8.8]/x').hostname)).toBe('public');
  });

  test('rejects a host outside the configured allowlist', () => {
    expect(() =>
      assertSafePresignedUploadUrl('https://evil.example.com/x', { allowedHosts: ['scw.cloud'] }),
    ).toThrow(/allowlist/);
  });

  test('accepts a subdomain of an allowlisted origin', () => {
    expect(() =>
      assertSafePresignedUploadUrl('https://s3.fr-par.scw.cloud/x', { allowedHosts: ['scw.cloud'] }),
    ).not.toThrow();
  });

  test('an invalid URL is rejected', () => {
    expect(() => assertSafePresignedUploadUrl('::::not a url')).toThrow(/valid URL/);
  });

  test('the thrown message never contains the query string', () => {
    try {
      assertSafePresignedUploadUrl('http://10.0.0.1/x?X-Amz-Signature=SECRETSIG');
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as Error).message).not.toContain('SECRETSIG');
      expect((err as Error).message).not.toContain('X-Amz-Signature');
    }
  });
});

describe('parseUploadHostAllowlist', () => {
  test('splits on commas and whitespace, trims, drops empties', () => {
    expect(parseUploadHostAllowlist('scw.cloud, s3.amazonaws.com\n  minio.local ')).toEqual([
      'scw.cloud',
      's3.amazonaws.com',
      'minio.local',
    ]);
  });
  test('empty/undefined → []', () => {
    expect(parseUploadHostAllowlist(undefined)).toEqual([]);
    expect(parseUploadHostAllowlist('')).toEqual([]);
  });
});

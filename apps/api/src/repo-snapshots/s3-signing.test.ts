/**
 * SigV4 canonicalization, in isolation.
 *
 * A signing bug is silent until a request is rejected, and the failure looks
 * like a credential problem rather than an encoding one. These lock the parts
 * that are easy to get subtly wrong — path encoding, header ordering, query
 * canonicalization — and pin the output so a refactor cannot quietly change it.
 *
 * Conformance against a real server is proved separately, by
 * `s3-publish.integration.test.ts` running against a live S3 API endpoint.
 */
import { describe, expect, test } from 'bun:test';
import { __internal, objectLocation, scopedKey, type RepoSnapshotBucket } from './s3';

const { uriEncode, signRequest } = __internal;

const virtualHosted: RepoSnapshotBucket = {
  bucket: 'kortix-snapshots',
  region: 'eu-west-2',
  forcePathStyle: false,
  prefix: '',
};
const pathStyle: RepoSnapshotBucket = {
  bucket: 'kortix-snapshots',
  region: 'us-east-1',
  endpoint: 'http://127.0.0.1:9000',
  forcePathStyle: true,
  prefix: 'dev/',
};
const credentials = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };

describe('uriEncode', () => {
  test('leaves the RFC 3986 unreserved set alone', () => {
    expect(uriEncode('abcXYZ019-._~', false)).toBe('abcXYZ019-._~');
  });

  test('percent-encodes everything else, uppercase hex', () => {
    expect(uriEncode(' ', false)).toBe('%20');
    expect(uriEncode('+', false)).toBe('%2B');
    expect(uriEncode('=', false)).toBe('%3D');
    // A literal '*' is NOT unreserved for SigV4 and must be encoded.
    expect(uriEncode('*', false)).toBe('%2A');
  });

  test('encodes a slash only when asked', () => {
    // Object keys keep their slashes; query VALUES must not.
    expect(uriEncode('a/b/c', false)).toBe('a/b/c');
    expect(uriEncode('a/b/c', true)).toBe('a%2Fb%2Fc');
  });

  test('encodes multi-byte UTF-8 per byte', () => {
    expect(uriEncode('é', false)).toBe('%C3%A9');
  });
});

describe('objectLocation', () => {
  test('virtual-hosted style puts the bucket in the host', () => {
    const location = objectLocation(virtualHosted, 'owner/repo/sha/1/project-snapshot-v1/d.tar.gz');
    expect(location.host).toBe('kortix-snapshots.s3.eu-west-2.amazonaws.com');
    expect(location.canonicalUri).toBe('/owner/repo/sha/1/project-snapshot-v1/d.tar.gz');
  });

  test('path style puts the bucket in the path and honours the prefix', () => {
    const location = objectLocation(pathStyle, 'owner/repo/sha/1/project-snapshot-v1/d.tar.gz');
    expect(location.host).toBe('127.0.0.1:9000');
    expect(location.canonicalUri).toBe(
      '/kortix-snapshots/dev/owner/repo/sha/1/project-snapshot-v1/d.tar.gz',
    );
  });

  test('the prefix cannot be escaped by a leading slash in the key', () => {
    expect(scopedKey(pathStyle, '/etc/passwd')).toBe('dev/etc/passwd');
  });

  test('a space in a key survives into a valid URL', () => {
    const location = objectLocation(virtualHosted, 'owner/my repo/sha/1/project-snapshot-v1/d.tar.gz');
    expect(location.canonicalUri).toContain('my%20repo');
    expect(() => new URL(location.url.toString())).not.toThrow();
  });
});

describe('signRequest', () => {
  const at = new Date('2026-09-12T00:00:00.000Z');

  function sign(overrides: Parameters<typeof signRequest>[0] extends infer T ? Partial<T> : never) {
    return signRequest({
      method: 'GET',
      location: objectLocation(virtualHosted, 'owner/repo/sha/1/project-snapshot-v1/d.tar.gz'),
      region: virtualHosted.region,
      credentials,
      payloadHash: __internal.EMPTY_SHA256,
      now: at,
      ...overrides,
    } as Parameters<typeof signRequest>[0]);
  }

  test('produces a stable signature for fixed inputs', () => {
    // A REGRESSION LOCK, recorded from this implementation — not an AWS
    // conformance vector. If it changes, the canonicalization changed, and that
    // is a thing to have decided rather than discovered. Conformance against a
    // real server is proved by `s3-publish.integration.test.ts`.
    expect(sign({}).authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20260912/eu-west-2/s3/aws4_request, ' +
        'SignedHeaders=host;x-amz-content-sha256;x-amz-date, ' +
        'Signature=f1eb59975ee1a0ddbc2f5a9100f7591ca529ff0a8980e66efadd3a596559e2e0',
    );
  });

  test('signs the headers it lists, in sorted order', () => {
    const headers = sign({ extraHeaders: { 'Content-Type': 'application/json', 'If-None-Match': '*' } });
    expect(headers.authorization).toContain(
      'SignedHeaders=content-type;host;if-none-match;x-amz-content-sha256;x-amz-date',
    );
    // Header names are lowercased for signing AND for sending.
    expect(headers['content-type']).toBe('application/json');
    expect(headers['if-none-match']).toBe('*');
  });

  test('a session token is signed, not merely sent', () => {
    const headers = sign({ credentials: { ...credentials, sessionToken: 'FQoGZXIvYXdzEExample' } });
    expect(headers.authorization).toContain('x-amz-security-token');
    expect(headers['x-amz-security-token']).toBe('FQoGZXIvYXdzEExample');
  });

  test('the signature is bound to the key, the method and the payload', () => {
    const base = sign({}).authorization;
    expect(sign({ method: 'PUT' }).authorization).not.toBe(base);
    expect(sign({ payloadHash: 'a'.repeat(64) }).authorization).not.toBe(base);
    expect(
      sign({ location: objectLocation(virtualHosted, 'owner/repo/sha/1/project-snapshot-v1/other.tar.gz') })
        .authorization,
    ).not.toBe(base);
  });
});

import { describe, expect, test } from 'bun:test';
import { buildPreviewAuthEndpoint } from './use-authenticated-preview-url';

describe('buildPreviewAuthEndpoint', () => {
  test('builds auth URLs from canonical preview paths', () => {
    expect(buildPreviewAuthEndpoint('http://localhost:8008/v1/p/kortix-sandbox/4502/index.html'))
      .toBe('http://localhost:8008/v1/p/auth');
  });

  test('derives the auth endpoint from a trusted server origin', () => {
    expect(buildPreviewAuthEndpoint(
      'http://localhost:8008/proxy/4502/v1/p/kortix-sandbox/4502/index.html',
      'http://localhost:8008/v1/p/kortix-sandbox/8000',
    )).toBe('http://localhost:8008/v1/p/auth');
  });

  test('rejects a proxied preview whose origin is not the trusted server', () => {
    expect(buildPreviewAuthEndpoint(
      'http://localhost:8000/proxy/4502/v1/p/kortix-sandbox/4502/index.html',
      'http://localhost:8008/v1/p/kortix-sandbox/8000',
    )).toBeNull();
  });

  test('never nests auth requests under a proxied app path', () => {
    expect(buildPreviewAuthEndpoint('http://localhost:8000/proxy/4502/v1/p/kortix-sandbox/4502/index.html'))
      .toBe('http://localhost:8000/v1/p/auth');
  });
});

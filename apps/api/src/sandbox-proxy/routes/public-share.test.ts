import { describe, expect, test } from 'bun:test';

const { PUBLIC_SHARE_SANDBOX_CSP, previewNavigationRedirect, publicResponseHeaders } = await import(
  './public-share'
);

describe('public-share path form response headers', () => {
  test('drops every upstream Set-Cookie, with or without a Domain attribute', () => {
    const upstream = new Headers();
    upstream.append('set-cookie', 'session=author; Domain=example.com; Path=/');
    upstream.append('set-cookie', 'plain=1; Path=/');
    upstream.set('content-type', 'text/html');
    const headers = publicResponseHeaders(upstream, '');
    expect(headers.get('set-cookie')).toBeNull();
    expect(headers.getSetCookie()).toEqual([]);
    expect(headers.get('content-type')).toBe('text/html');
  });

  test('runs author content in an opaque origin and keeps the author policy', () => {
    const upstream = new Headers({ 'content-security-policy': "default-src 'self'; frame-ancestors 'none'" });
    const headers = publicResponseHeaders(upstream, '');
    const policies = headers.get('content-security-policy') ?? '';
    expect(policies).toContain("default-src 'self'");
    expect(policies).not.toContain('frame-ancestors');
    expect(policies).toContain(PUBLIC_SHARE_SANDBOX_CSP);
    expect(PUBLIC_SHARE_SANDBOX_CSP.startsWith('sandbox ')).toBe(true);
    expect(PUBLIC_SHARE_SANDBOX_CSP).not.toContain('allow-same-origin');
    expect(headers.get('x-content-type-options')).toBe('nosniff');
  });

  test('adds the sandbox policy when upstream sends none', () => {
    const headers = publicResponseHeaders(new Headers(), 'https://viewer.example');
    expect(headers.get('content-security-policy')).toBe(PUBLIC_SHARE_SANDBOX_CSP);
    expect(headers.get('access-control-allow-credentials')).toBe('false');
  });
});

describe('public-share path form navigation redirect', () => {
  const base = {
    method: 'GET',
    fetchDest: 'document',
    previewOrigin: 'https://dev-p3000-abc.preview.example',
    path: '/docs',
    search: '?q=1',
    token: 'kps_token',
  };

  test('a document navigation goes to the preview origin with the share token', () => {
    expect(previewNavigationRedirect(base)).toBe(
      'https://dev-p3000-abc.preview.example/docs?q=1&public_share=kps_token',
    );
    expect(previewNavigationRedirect({ ...base, fetchDest: 'iframe', search: '' })).toBe(
      'https://dev-p3000-abc.preview.example/docs?public_share=kps_token',
    );
  });

  test('programmatic requests, writes, and deployments without a preview domain stay on the path form', () => {
    expect(previewNavigationRedirect({ ...base, fetchDest: 'empty' })).toBeNull();
    expect(previewNavigationRedirect({ ...base, fetchDest: undefined })).toBeNull();
    expect(previewNavigationRedirect({ ...base, method: 'POST' })).toBeNull();
    expect(previewNavigationRedirect({ ...base, previewOrigin: null })).toBeNull();
  });
});

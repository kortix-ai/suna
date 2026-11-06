import { expect, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { middleware } from './middleware';

// KRTX-3380 (pentest http.contract): a visitor who arrives over plain HTTP —
// dev.kortix.com, kortix.com — got the page (or the auth gate) instead of the
// HTTPS origin, so cookies and flows never forced the secure scheme. The edge
// (Cloudflare -> ALB) forwards the visitor's scheme in `x-forwarded-proto`
// (first hop first) and `cf-visitor`; the middleware must 308-redirect to the
// same https URL before any auth or content decision.

async function redirectLocation(req: NextRequest): Promise<URL | null> {
  const res = await middleware(req);
  if (res.status !== 308) return null;
  return new URL(res.headers.get('location') ?? '');
}

test('a plain-HTTP request is 308-redirected to the same https URL', async () => {
  const req = new NextRequest('http://kortix.com/pricing?ref=hero');
  req.headers.set('x-forwarded-proto', 'http');
  const location = await redirectLocation(req);
  expect(location?.protocol).toBe('https:');
  expect(location?.host).toBe('kortix.com');
  expect(location?.pathname).toBe('/pricing');
  expect(location?.search).toBe('?ref=hero');
});

test('the first hop of a comma-separated x-forwarded-proto decides', async () => {
  // Proxy chains append their own hop; the leftmost value is the client's.
  const req = new NextRequest('http://dev.kortix.com/projects');
  req.headers.set('x-forwarded-proto', 'http, https');
  const location = await redirectLocation(req);
  expect(location?.protocol).toBe('https:');
  expect(location?.host).toBe('dev.kortix.com');
  expect(location?.pathname).toBe('/projects');
});

test('a cf-visitor scheme of http redirects when x-forwarded-proto is absent', async () => {
  const req = new NextRequest('http://dev.kortix.com/about');
  req.headers.set('cf-visitor', '{"scheme":"http"}');
  const location = await redirectLocation(req);
  expect(location?.protocol).toBe('https:');
  expect(location?.pathname).toBe('/about');
});

test('https traffic and headerless local traffic pass through untouched', async () => {
  for (const headers of [
    [['x-forwarded-proto', 'https']],
    [['cf-visitor', '{"scheme":"https"}']],
    [],
  ] as const) {
    const req = new NextRequest('http://localhost:3000/pricing');
    for (const [key, value] of headers) req.headers.set(key, value);
    const res = await middleware(req);
    expect(res.status).not.toBe(308);
  }
});

test('the ALB health check path is never redirected', async () => {
  // The target group probes /api/health over HTTP inside the VPC. A 308 there
  // would flip healthy targets out of rotation.
  const req = new NextRequest('http://localhost:3000/api/health');
  req.headers.set('x-forwarded-proto', 'http');
  const res = await middleware(req);
  expect(res.status).not.toBe(308);
});

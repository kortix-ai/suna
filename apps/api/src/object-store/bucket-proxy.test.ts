import { afterAll, expect, test } from 'bun:test';
import { bucketProxy } from './bucket-proxy';

// A scripted store: echoes what reached it.
const store = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/boom')) return new Response('x', { status: 403, headers: { 'x-amz-request-id': 'req-1' } });
    return Response.json({ method: request.method, path: url.pathname, query: url.search, host: request.headers.get('host'), length: request.headers.get('content-length'), chunked: request.headers.get('transfer-encoding'), auth: request.headers.get('authorization'), body: await request.text() });
  },
});
afterAll(() => store.stop(true));
const handle = bucketProxy(`http://127.0.0.1:${store.port}/`, 'kortix-capture', 'capture');

test('forwards path, query, method, body and the signed Host and Authorization unchanged', async () => {
  const res = await handle(
    new Request('http://api.example.test/kortix-capture/orgs/a/d/chunk.mp4?uploadId=1', {
      method: 'PUT',
      headers: { host: 'api.example.test', 'content-length': '11', authorization: 'AWS4-HMAC-SHA256 Credential=synthetic' },
      body: 'chunk-bytes',
    }),
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    method: 'PUT',
    path: '/kortix-capture/orgs/a/d/chunk.mp4',
    query: '?uploadId=1',
    host: 'api.example.test',
    // The store refuses a chunked PUT with 411, so the length must reach it.
    length: '11',
    chunked: null,
    auth: 'AWS4-HMAC-SHA256 Credential=synthetic',
    body: 'chunk-bytes',
  });
});

test('sends the host the client signed for when a proxy in front rewrote Host', async () => {
  // A preview's Platinum ingress rewrites Host; the store then rejects the
  // presigned signature (SignatureDoesNotMatch) unless the signed host is restored.
  const signed = bucketProxy(`http://127.0.0.1:${store.port}/`, 'kortix-project-snapshots', 'project snapshot', 'api.example.test');
  const res = await signed(new Request('http://internal.example.test/kortix-project-snapshots/a/tree.tar.gz?X-Amz-Signature=synthetic', { headers: { host: 'internal.example.test' } }));
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ method: 'GET', path: '/kortix-project-snapshots/a/tree.tar.gz', query: '?X-Amz-Signature=synthetic', host: 'api.example.test' });
});

test('passes the store’s status and headers through', async () => {
  const res = await handle(new Request('http://api.example.test/kortix-capture/boom'));
  expect(res.status).toBe(403);
  expect(res.headers.get('x-amz-request-id')).toBe('req-1');
});

test('serves the bucket root and nothing outside the bucket prefix', async () => {
  expect((await handle(new Request('http://api.example.test/kortix-capture?list-type=2'))).status).toBe(200);
  expect((await handle(new Request('http://api.example.test/kortix-capture-other/x'))).status).toBe(404);
  expect((await handle(new Request('http://api.example.test/minio/admin/v3/info'))).status).toBe(404);
  expect((await handle(new Request('http://api.example.test/kortix-capture/../minio/admin/v3/info'))).status).toBe(404);
});

test('an unreachable store answers 503 with Retry-After', async () => {
  const down = bucketProxy('http://127.0.0.1:1', 'kortix-capture', 'capture');
  const res = await down(new Request('http://api.example.test/kortix-capture/k', { method: 'PUT', body: 'x' }));
  expect(res.status).toBe(503);
  expect(res.headers.get('retry-after')).toBe('5');
});

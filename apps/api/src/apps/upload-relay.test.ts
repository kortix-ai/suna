import { describe, expect, test } from 'bun:test';
import { createAppArtifactUploadRelay } from './upload-relay';

describe('App artifact upload relay', () => {
  test('forwards one signed app-artifacts upload to configured Supabase Storage', async () => {
    const requests: Array<{ url: string; method: string; body: string; contentType: string | null; upsert: string | null }> = [];
    const relay = createAppArtifactUploadRelay({
      supabaseUrl: 'http://127.0.0.1:54321',
      fetchImpl: async (input, init) => {
        const request = new Request(input, init);
        requests.push({
          url: request.url,
          method: request.method,
          body: await request.text(),
          contentType: request.headers.get('content-type'),
          upsert: request.headers.get('x-upsert'),
        });
        return new Response('{"Key":"stored"}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    const response = await relay.request(
      '/app-artifacts/account/project/artifact/source.tar.gz?token=signed-token',
      {
        method: 'PUT',
        body: 'archive-bytes',
        headers: { 'content-type': 'application/gzip', 'x-upsert': 'false' },
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ Key: 'stored' });
    expect(requests).toEqual([{
      url: 'http://127.0.0.1:54321/storage/v1/object/upload/sign/app-artifacts/account/project/artifact/source.tar.gz?token=signed-token',
      method: 'PUT',
      body: 'archive-bytes',
      contentType: 'application/gzip',
      upsert: 'false',
    }]);
  });

  test('rejects unsigned, cross-bucket, and oversized uploads before forwarding', async () => {
    let forwarded = 0;
    const relay = createAppArtifactUploadRelay({
      supabaseUrl: 'http://127.0.0.1:54321',
      maxBytes: 4,
      fetchImpl: async () => {
        forwarded += 1;
        return new Response(null, { status: 200 });
      },
    });

    expect((await relay.request('/app-artifacts/a/p/r/source.tar.gz', {
      method: 'PUT', body: 'abc',
    })).status).toBe(400);
    expect((await relay.request('/other-bucket/a/p/r/source.tar.gz?token=signed', {
      method: 'PUT', body: 'abc',
    })).status).toBe(404);
    expect((await relay.request('/app-artifacts/a/p/r/source.tar.gz?token=signed', {
      method: 'PUT', body: '12345',
    })).status).toBe(413);
    expect(forwarded).toBe(0);
  });
});

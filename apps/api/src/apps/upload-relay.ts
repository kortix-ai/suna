import { Hono } from 'hono';
import { APP_ARTIFACT_BUCKET, MAX_ARCHIVE_BYTES } from './artifacts';

const OBJECT_SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;

export interface AppArtifactUploadRelayOptions {
  supabaseUrl: string;
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  maxBytes?: number;
}

/**
 * Relay only Supabase-signed App archive uploads. The signed `token` remains
 * the authority. The relay cannot select another bucket, object shape, method,
 * or upstream host.
 */
export function createAppArtifactUploadRelay(options: AppArtifactUploadRelayOptions) {
  const app = new Hono();
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxBytes = options.maxBytes ?? MAX_ARCHIVE_BYTES;

  app.put('/:bucket/:accountId/:projectId/:artifactId/source.tar.gz', async (c) => {
    if (c.req.param('bucket') !== APP_ARTIFACT_BUCKET) {
      return c.json({ error: 'Not found' }, 404);
    }
    const segments = [
      c.req.param('accountId'),
      c.req.param('projectId'),
      c.req.param('artifactId'),
    ];
    if (!segments.every((segment) => OBJECT_SEGMENT.test(segment))) {
      return c.json({ error: 'Invalid App artifact path' }, 400);
    }
    const objectPath = `${segments.join('/')}\/source.tar.gz`.replace('\\/', '/');
    const token = c.req.query('token');
    if (!token) return c.json({ error: 'Missing signed upload token' }, 400);

    const declaredBytes = Number(c.req.header('content-length') ?? 0);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      return c.json({ error: `App artifact exceeds ${maxBytes} bytes` }, 413);
    }
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      return c.json({ error: `App artifact exceeds ${maxBytes} bytes` }, 413);
    }

    const target = new URL(
      `/storage/v1/object/upload/sign/${APP_ARTIFACT_BUCKET}/${objectPath}`,
      options.supabaseUrl,
    );
    target.searchParams.set('token', token);
    const upstream = await fetchImpl(target, {
      method: 'PUT',
      body: bytes,
      headers: {
        'content-type': c.req.header('content-type') ?? 'application/gzip',
        'x-upsert': c.req.header('x-upsert') ?? 'false',
      },
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: upstream.headers.get('content-type')
        ? { 'content-type': upstream.headers.get('content-type')! }
        : undefined,
    });
  });

  return app;
}

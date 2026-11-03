/**
 * Bucket passthrough for a self-host without a domain.
 *
 * A client signs its S3 request with SigV4, which covers the request's host
 * and path. So the client must reach the store at the exact host and path it
 * signed. Path-style S3 puts the bucket first in the path (`/<bucket>/<key>`),
 * which no other API route uses. This forwards that one path prefix, byte for
 * byte and with the Host header the client signed, to the in-network store
 * (the self-host MinIO). The store checks every signature; this code reads
 * none and holds no credential.
 *
 * Two buckets use it: Capture (devices upload) and the project snapshots
 * (sandboxes download through a presigned URL).
 *
 * Domain mode does not use it: Caddy routes the same prefixes to the store
 * directly (self-host Caddyfile), so transfers survive an API roll-out.
 */
import { request as httpRequest, type IncomingHttpHeaders, type OutgoingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { logger } from '../lib/logger';

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

function requestHeaders(from: Headers): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  from.forEach((value, name) => {
    if (!HOP_BY_HOP.has(name)) out[name] = value;
  });
  return out;
}

function responseHeaders(from: IncomingHttpHeaders): Headers {
  const out = new Headers();
  for (const [name, value] of Object.entries(from)) {
    if (value === undefined || HOP_BY_HOP.has(name)) continue;
    for (const v of Array.isArray(value) ? value : [value]) out.append(name, v);
  }
  return out;
}

/**
 * The handler for one bucket: `target` is the store's in-network origin,
 * `bucket` the only path prefix it serves, `name` the label in logs and in
 * the 503 body. `signedHost` is the host of the public endpoint every
 * client signs for (the API signs presigned URLs and hands devices that
 * endpoint). A proxy in front of the API can rewrite Host (a preview's
 * Platinum ingress does), and the store then answers `SignatureDoesNotMatch`,
 * so the request goes out with `signedHost` when one is set. A signature made
 * for any other host still fails at the store.
 *
 * node:http, not fetch: a streamed request body goes out chunked in fetch, and
 * the store refuses a chunked PUT without a Content-Length (411). node:http
 * keeps the client's Content-Length and still streams, with no buffering.
 */
export function bucketProxy(target: string, bucket: string, name: string, signedHost?: string): (request: Request) => Promise<Response> {
  const origin = new URL(target);
  const send = origin.protocol === 'https:' ? httpsRequest : httpRequest;
  return (request) =>
    new Promise<Response>((resolve) => {
      const url = new URL(request.url);
      if (url.pathname !== `/${bucket}` && !url.pathname.startsWith(`/${bucket}/`)) return resolve(new Response('Not Found', { status: 404 }));
      const unavailable = (error: unknown) => {
        logger.error(`[object-store] ${name} store passthrough failed`, { error: String(error) });
        // 503 + Retry-After: the device uploader and the sandbox download both retry; a 502 would read as a bad request.
        resolve(new Response(`${name} store unavailable`, { status: 503, headers: { 'retry-after': '5' } }));
      };
      const upstream = send(
        {
          protocol: origin.protocol,
          hostname: origin.hostname,
          port: origin.port || undefined,
          method: request.method,
          path: `${url.pathname}${url.search}`,
          // The signature covers the Host the client signed for: keep it, or
          // restore it when a proxy in front rewrote it.
          headers: { ...requestHeaders(request.headers), ...(signedHost ? { host: signedHost } : {}) },
        },
        (res) => {
          const noBody = request.method === 'HEAD' || res.statusCode === 204 || res.statusCode === 304;
          resolve(new Response(noBody ? null : (Readable.toWeb(res) as unknown as ReadableStream), { status: res.statusCode ?? 502, headers: responseHeaders(res.headers) }));
        },
      );
      upstream.on('error', unavailable);
      // The client gave up mid-transfer: stop sending, the store discards a partial upload.
      request.signal.addEventListener('abort', () => upstream.destroy());
      if (request.body && request.method !== 'GET' && request.method !== 'HEAD') {
        Readable.fromWeb(request.body as unknown as import('node:stream/web').ReadableStream).on('error', unavailable).pipe(upstream);
      } else {
        upstream.end();
      }
    });
}

/** The host of a public endpoint URL, or undefined when it is unset or not a URL. */
function hostOf(endpoint: string | undefined): string | undefined {
  try {
    return endpoint?.trim() ? new URL(endpoint.trim()).host : undefined;
  } catch {
    return undefined;
  }
}

/** Mounts the passthrough for one bucket when both its target and its bucket are set. */
export function mountBucketProxy(
  app: OpenAPIHono,
  input: { target: string | undefined; bucket: string | undefined; publicEndpoint: string | undefined; name: string },
): void {
  const target = (input.target ?? '').trim();
  const bucket = (input.bucket ?? '').trim();
  if (!target || !bucket) return;
  const handle = bucketProxy(target, bucket, input.name, hostOf(input.publicEndpoint));
  app.all(`/${bucket}`, (c) => handle(c.req.raw));
  app.all(`/${bucket}/*`, (c) => handle(c.req.raw));
}

/**
 * Capture store passthrough for a self-host without a domain.
 *
 * A device writes to the store with SigV4, which signs the request's host and
 * path. So the device must reach the store at the exact host and path it signs.
 * Path-style S3 puts the bucket first in the path (`/<bucket>/<key>`), which no
 * other API route uses. This forwards that one path prefix, byte for byte and
 * with the Host header the client signed, to the in-network store. The store
 * checks every signature; this code reads none and holds no credential.
 *
 * Domain mode does not use it: Caddy routes the same prefix to the store
 * directly (self-host Caddyfile), so uploads survive an API roll-out.
 */
import { request as httpRequest, type IncomingHttpHeaders, type OutgoingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { config } from '../config';
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
 * The handler for one store: `target` is its in-network origin, `bucket` the only path prefix it serves.
 *
 * node:http, not fetch: a streamed request body goes out chunked in fetch, and
 * the store refuses a chunked PUT without a Content-Length (411). node:http
 * keeps the client's Content-Length and still streams, with no buffering.
 */
export function captureStoreProxy(target: string, bucket: string): (request: Request) => Promise<Response> {
  const origin = new URL(target);
  const send = origin.protocol === 'https:' ? httpsRequest : httpRequest;
  return (request) =>
    new Promise<Response>((resolve) => {
      const url = new URL(request.url);
      if (url.pathname !== `/${bucket}` && !url.pathname.startsWith(`/${bucket}/`)) return resolve(new Response('Not Found', { status: 404 }));
      const unavailable = (error: unknown) => {
        logger.error('[capture] store passthrough failed', { error: String(error) });
        // 503 + Retry-After: the device's uploader retries; a 502 would read as a bad request.
        resolve(new Response('capture store unavailable', { status: 503, headers: { 'retry-after': '5' } }));
      };
      const upstream = send(
        {
          protocol: origin.protocol,
          hostname: origin.hostname,
          port: origin.port || undefined,
          method: request.method,
          path: `${url.pathname}${url.search}`,
          // The signature covers the Host the client used: keep it.
          headers: requestHeaders(request.headers),
        },
        (res) => {
          const noBody = request.method === 'HEAD' || res.statusCode === 204 || res.statusCode === 304;
          resolve(new Response(noBody ? null : (Readable.toWeb(res) as unknown as ReadableStream), { status: res.statusCode ?? 502, headers: responseHeaders(res.headers) }));
        },
      );
      upstream.on('error', unavailable);
      // The client gave up mid-upload: stop sending, the store discards the partial object.
      request.signal.addEventListener('abort', () => upstream.destroy());
      if (request.body && request.method !== 'GET' && request.method !== 'HEAD') {
        Readable.fromWeb(request.body as unknown as import('node:stream/web').ReadableStream).on('error', unavailable).pipe(upstream);
      } else {
        upstream.end();
      }
    });
}

/** Mounts the passthrough when `KORTIX_CAPTURE_S3_PROXY_TARGET` and the bucket are set. */
export function registerCaptureStoreProxy(app: OpenAPIHono): void {
  const target = (config.KORTIX_CAPTURE_S3_PROXY_TARGET ?? '').trim();
  const bucket = (config.KORTIX_CAPTURE_S3_BUCKET ?? '').trim();
  if (!target || !bucket) return;
  const handle = captureStoreProxy(target, bucket);
  app.all(`/${bucket}`, (c) => handle(c.req.raw));
  app.all(`/${bucket}/*`, (c) => handle(c.req.raw));
}

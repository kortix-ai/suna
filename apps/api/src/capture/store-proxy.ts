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
import type { Hono } from 'hono';
import { config } from '../config';
import { logger } from '../lib/logger';

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

function forwardHeaders(from: Headers): Headers {
  const out = new Headers();
  from.forEach((value, name) => {
    if (!HOP_BY_HOP.has(name)) out.set(name, value);
  });
  return out;
}

/** The handler for one store: `target` is its in-network origin, `bucket` the only path prefix it serves. */
export function captureStoreProxy(target: string, bucket: string): (request: Request) => Promise<Response> {
  const origin = target.replace(/\/+$/, '');
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname !== `/${bucket}` && !url.pathname.startsWith(`/${bucket}/`)) return new Response('Not Found', { status: 404 });
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    try {
      const upstream = await fetch(`${origin}${url.pathname}${url.search}`, {
        method: request.method,
        // Bun sends this Host as written: the signature covers it.
        headers: forwardHeaders(request.headers),
        body: hasBody ? request.body : undefined,
        duplex: 'half',
        redirect: 'manual',
        decompress: false,
      } as RequestInit);
      return new Response(upstream.body, { status: upstream.status, headers: forwardHeaders(upstream.headers) });
    } catch (error) {
      logger.error('[capture] store passthrough failed', { error: String(error) });
      // 503 + Retry-After: the device's uploader retries; a 502 would read as a bad request.
      return new Response('capture store unavailable', { status: 503, headers: { 'retry-after': '5' } });
    }
  };
}

/** Mounts the passthrough when `KORTIX_CAPTURE_S3_PROXY_TARGET` and the bucket are set. */
export function registerCaptureStoreProxy(app: Hono): void {
  const target = (config.KORTIX_CAPTURE_S3_PROXY_TARGET ?? '').trim();
  const bucket = (config.KORTIX_CAPTURE_S3_BUCKET ?? '').trim();
  if (!target || !bucket) return;
  const handle = captureStoreProxy(target, bucket);
  app.all(`/${bucket}`, (c) => handle(c.req.raw));
  app.all(`/${bucket}/*`, (c) => handle(c.req.raw));
}

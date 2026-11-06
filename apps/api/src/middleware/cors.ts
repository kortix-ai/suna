import { cors } from 'hono/cors';
import { KORTIX_EXTENSION_ORIGIN } from '../shared/kortix-extension';

const CLOUD_ORIGINS = [
  'https://www.kortix.com',
  'https://kortix.com',
  'https://dev.kortix.com',
  'https://staging.kortix.com',
  'https://kortix.cloud',
  'https://www.kortix.cloud',
];

const LOCAL_ORIGINS = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:3010',
  'http://127.0.0.1:3010',
];

const PREVIEW_ORIGIN = /^https:\/\/[a-z0-9-]+\.(vercel\.app|preview\.kortix\.com)$/i;
/** `PREVIEW_ORIGIN` as CSP source expressions. */
const PREVIEW_ORIGIN_SOURCES = ['https://*.vercel.app', 'https://*.preview.kortix.com'];

interface CorsMiddlewareOptions {
  internalEnvironment: string;
  extraOrigins: string[];
}

/** The web app origins the API trusts: the cloud and local hosts, and `extraOrigins`. */
export function trustedWebOrigins(extraOrigins: readonly string[]): Set<string> {
  return new Set([...CLOUD_ORIGINS, ...LOCAL_ORIGINS, ...extraOrigins.map((origin) => origin.trim()).filter(Boolean)]);
}

/** The http(s) origin of `value`, or null when it is not an http(s) URL. */
function httpOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * `frame-ancestors` for a page that only the Kortix web app may frame: every origin CORS
 * trusts, as an exact origin; the preview hosts on a preview; and the Kortix in Chrome side
 * panel, which frames the web app. A value that is not an http(s) URL is left out, and no
 * other wildcard is added: user apps and sandbox previews live under `*.kortix.com`.
 */
export function webAppFrameAncestors(options: CorsMiddlewareOptions): string {
  const sources = new Set<string>();
  for (const value of trustedWebOrigins(options.extraOrigins)) {
    const origin = httpOrigin(value);
    if (origin) sources.add(origin);
  }
  if (options.internalEnvironment === 'preview') for (const source of PREVIEW_ORIGIN_SOURCES) sources.add(source);
  sources.add(KORTIX_EXTENSION_ORIGIN);
  return `frame-ancestors ${[...sources].join(' ')}`;
}

export function createCorsMiddleware(options: CorsMiddlewareOptions) {
  const allowedOrigins = trustedWebOrigins(options.extraOrigins);
  const allowPreviewOrigins = options.internalEnvironment === 'preview';

  return cors({
    origin: (origin) => {
      if (!origin) return origin;
      if (allowedOrigins.has(origin)) return origin;
      if (allowPreviewOrigins && PREVIEW_ORIGIN.test(origin)) return origin;
      return null;
    },
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: [
      'Content-Type',
      'Authorization',
      'X-Kortix-Token',
      'Mcp-Protocol-Version',
      'Mcp-Session-Id',
      'X-Api-Key',
      'Accept',
      'X-Kortix-Signature',
      'X-Hub-Signature-256',
      'traceparent',
      'tracestate',
      'X-Request-Id',
      'Last-Event-ID',
      // The API no longer reads or sends X-Kortix-Client (the audit records the
      // authenticated credential). Keep it allowed: browser tabs and cached web
      // builds from before the change still send it, and dropping it here would
      // fail their CORS preflight.
      'X-Kortix-Client',
      // The SDK sends the host's release version on every request (R0.6).
      'X-Kortix-Client-Version',
      // Defense in depth for the session stream: a cross-origin SSE reader that
      // sends `Cache-Control: no-cache` (older SDKs, the opencode fallback) would
      // otherwise fail preflight and the stream would never open. The current SDK
      // no longer sends it, but allowing it keeps any client that does working.
      'Cache-Control',
      // Act-as impersonation. A header absent from this list is stripped by the
      // browser's preflight, so the request arrives WITHOUT the grant and runs
      // as the operator's own account — the exact silent mis-scoping the
      // server-side design refuses to allow. It has to be declared here for the
      // banner to ever be true in a browser.
      'X-Kortix-Impersonate',
      // The retired read-only admin bypass. The API ignores it; it stays allowed
      // so an older SDK that still sends it passes its preflight.
      'X-Kortix-Admin-Bypass',
    ],
    exposeHeaders: [
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'X-RateLimit-Reset',
      'Retry-After',
      'X-Next-Cursor',
      'X-Request-Id',
      'X-Audit-Row-Count',
      'X-Audit-Capped',
      'X-Audit-Complete',
      'X-Audit-Next-Cursor',
      // The sandbox proxy's failure attribution (`proxy-hop.ts`). It HAS to be
      // declared here and not only on the proxy's own response: this middleware
      // is mounted with `app.use('*', …)` on the same app the proxy is routed
      // into, and Hono's `Context.res` setter copies the middleware's headers
      // onto the handler's response — the middleware's
      // `Access-Control-Expose-Headers` overwrites the handler's. Without these
      // two names the browser hides both headers from JS, the SDK probe reads
      // null, and every failure is unattributed again.
      'X-Kortix-Proxy-Hop',
      'X-Kortix-Upstream-Status',
      // The daemon's structured boot progress (`bootPhaseLabel`, proxy.ts:313).
      // Without this the browser cannot read it, which is why every client
      // classifies readiness by matching the English error body instead.
      'X-Kortix-Boot-Phase',
      // Per-request cost attribution, `up;dur=` (time inside the sandbox /
      // upstream fetch) vs `api;dur=` (everything this API did around it). Its
      // whole point is to be readable from a browser HAR, so it has to survive
      // the cross-origin boundary — the mid-path ~1.2 s on a proxied session
      // read could not be split from outside precisely because nothing exposed
      // this. See middleware/upstream-timing.ts.
      'Server-Timing',
    ],
    credentials: true,
    maxAge: 600,
  });
}

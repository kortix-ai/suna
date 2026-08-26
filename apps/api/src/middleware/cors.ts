import { cors } from 'hono/cors';

const CLOUD_ORIGINS = [
  'https://www.kortix.com',
  'https://kortix.com',
  'https://dev.kortix.com',
  'https://new-dev.kortix.com',
  'https://dev-new.kortix.com',
  'https://staging.kortix.com',
  'https://kortix.cloud',
  'https://www.kortix.cloud',
  'https://new.kortix.com',
];

const LOCAL_ORIGINS = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:3010',
  'http://127.0.0.1:3010',
];

const PREVIEW_ORIGIN = /^https:\/\/[a-z0-9-]+\.(vercel\.app|preview\.kortix\.com)$/i;

interface CorsMiddlewareOptions {
  internalEnvironment: string;
  extraOrigins: string[];
}

export function createCorsMiddleware(options: CorsMiddlewareOptions) {
  const allowedOrigins = new Set([
    ...CLOUD_ORIGINS,
    ...LOCAL_ORIGINS,
    ...options.extraOrigins.map((origin) => origin.trim()).filter(Boolean),
  ]);
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
      'X-Api-Key',
      'Accept',
      'X-Kortix-Signature',
      'X-Hub-Signature-256',
      'traceparent',
      'tracestate',
      'X-Request-Id',
      'Last-Event-ID',
      'X-Kortix-Client',
      // Act-as impersonation. A header absent from this list is stripped by the
      // browser's preflight, so the request arrives WITHOUT the grant and runs
      // as the operator's own account — the exact silent mis-scoping the
      // server-side design refuses to allow. It has to be declared here for the
      // banner to ever be true in a browser.
      'X-Kortix-Impersonate',
      // Same reason for the platform-admin read-only bypass the SDK already
      // attaches (setAdminBypass → `x-kortix-admin-bypass: 1`): without it, the
      // header never survives a cross-origin preflight.
      'X-Kortix-Admin-Bypass',
    ],
    exposeHeaders: [
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
    ],
    credentials: true,
    maxAge: 600,
  });
}

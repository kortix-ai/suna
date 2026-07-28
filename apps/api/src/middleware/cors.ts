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
    ],
    exposeHeaders: ['X-Next-Cursor', 'X-Request-Id'],
    credentials: true,
    maxAge: 600,
  });
}

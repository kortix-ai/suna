import { combinedAuth } from '../middleware/auth';
import { preview } from './routes/preview';
import { getAuthToken } from './routes/auth';
import { previewTicket } from './routes/preview-ticket';
import { previewConfig } from './routes/preview-config';
import { publicShareApp } from './routes/public-share';
import { shareApp } from './routes/share';
import { isCookieCsrfRefused } from './cookie-csrf';
import { prefetchSandbox } from './http-prefetch';
import { createSandboxProxyRateLimitMiddleware } from '../middleware/rate-limit';
import { sandboxInflightGate } from './sandbox-inflight';
import { makeOpenApiApp } from '../openapi';
import type { Context, Next } from 'hono';

// OpenAPIHono root: the /auth + /share sub-apps contribute typed route defs to
// the spec; the path-based `preview` proxy stays a raw streaming Hono catch-all
// (mounted below) — its proxied traffic is not modeled as JSON.
const sandboxProxyApp = makeOpenApiApp();

// ── Cookie auth endpoint ────────────────────────────────────────────────────
// POST /v1/p/auth — validates JWT and sets __preview_session cookie.
sandboxProxyApp.route('/auth', getAuthToken);

// ── Preview addressing ──────────────────────────────────────────────────────
// GET /v1/p/config — the origin template clients use to build preview URLs.
sandboxProxyApp.route('/config', previewConfig);
sandboxProxyApp.route('/ticket', previewTicket);

// ── Public URL share endpoint ───────────────────────────────────────────────
// POST /v1/p/share — returns a shareable URL for a sandbox port.
sandboxProxyApp.route('/share', shareApp);

// ── Public session preview shares ───────────────────────────────────────────
// GET /v1/p/public-share/:token and /v1/p/public-share/:token/:port/*
// are token-gated public artifact previews, intentionally separate from the
// authenticated /:sandboxId/:port proxy below.
sandboxProxyApp.route('/public-share', publicShareApp);

// ── Path-based proxy ────────────────────────────────────────────────────────
// Order is load-bearing: authenticate, then rate-limit, and only then start
// reading the sandbox row (http-prefetch.ts). A row read on a miss falls back to a
// case-insensitive `external_id` scan, so it must never be reachable by an
// unauthenticated or over-limit caller. Started here, the read overlaps the
// rest of the request before `forwardToSandbox` needs it (the body read).
// Auth middleware accepts Supabase JWT, kortix_ tokens, and cookies.
// Before authentication: a write that rides only the ambient cookie from another
// origin is refused (cookie-csrf.ts).
sandboxProxyApp.use('/:sandboxId/:port/*', cookieCsrfGate);
sandboxProxyApp.use('/:sandboxId/:port', cookieCsrfGate);
sandboxProxyApp.use('/:sandboxId/:port/*', combinedAuth);
sandboxProxyApp.use('/:sandboxId/:port', combinedAuth);
// Per-sandbox in-flight stamp for the request log (KRTX-471). After auth (only
// credentialed traffic counts) and before the rate limit, so a herd the limiter
// sheds is still counted.
sandboxProxyApp.use('/:sandboxId/:port/*', sandboxInflightGate);
sandboxProxyApp.use('/:sandboxId/:port', sandboxInflightGate);
sandboxProxyApp.use('/:sandboxId/:port/*', createSandboxProxyRateLimitMiddleware());
sandboxProxyApp.use('/:sandboxId/:port', createSandboxProxyRateLimitMiddleware());
sandboxProxyApp.use('/:sandboxId/:port/*', prefetchSandboxRow);
sandboxProxyApp.use('/:sandboxId/:port', prefetchSandboxRow);

async function cookieCsrfGate(c: Context, next: Next) {
  if (isCookieCsrfRefused(c.req.raw)) {
    return c.json({ error: 'cross-origin write with an ambient preview cookie', code: 'CSRF_REFUSED' }, 403);
  }
  await next();
}

async function prefetchSandboxRow(c: Context, next: Next) {
  const sandboxId = c.req.param('sandboxId');
  // `combinedAuth` lets a CORS preflight through without a credential; an
  // identity is set only by a credential that verified. Neither is forgeable.
  if (sandboxId && c.req.method !== 'OPTIONS' && c.get('userId')) {
    prefetchSandbox(c, sandboxId);
  }
  await next();
}

// Every sandbox serves from a per-sandbox URL — the preview handler reads it
// from the row (`baseUrl`) or fetches it from Daytona's SDK. No per-provider
// dispatch needed in this thin proxy.
sandboxProxyApp.route('/', preview);

export { sandboxProxyApp };

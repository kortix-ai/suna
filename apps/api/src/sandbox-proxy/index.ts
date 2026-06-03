import { Hono } from 'hono';
import { combinedAuth } from '../middleware/auth';
import { preview } from './routes/preview';
import { getAuthToken } from './routes/auth';
import { shareApp } from './routes/share';
import { createSandboxProxyRateLimitMiddleware } from '../shared/rate-limit';
export { invalidateProviderCache, resolveProvider } from './provider';

const sandboxProxyApp = new Hono();

// ── Cookie auth endpoint ────────────────────────────────────────────────────
// POST /v1/p/auth — validates JWT and sets __preview_session cookie.
sandboxProxyApp.route('/auth', getAuthToken);

// ── Public URL share endpoint ───────────────────────────────────────────────
// POST /v1/p/share — returns a shareable URL for a sandbox port.
sandboxProxyApp.route('/share', shareApp);

// ── Path-based proxy ────────────────────────────────────────────────────────
// Auth middleware accepts Supabase JWT, kortix_ tokens, and cookies.
sandboxProxyApp.use('/:sandboxId/:port/*', combinedAuth);
sandboxProxyApp.use('/:sandboxId/:port', combinedAuth);
sandboxProxyApp.use('/:sandboxId/:port/*', createSandboxProxyRateLimitMiddleware());
sandboxProxyApp.use('/:sandboxId/:port', createSandboxProxyRateLimitMiddleware());

// Every sandbox serves from a per-sandbox URL — the preview handler reads it
// from the row (`baseUrl`) or fetches it from Daytona's SDK. No per-provider
// dispatch needed in this thin proxy.
sandboxProxyApp.route('/', preview);

export { sandboxProxyApp };

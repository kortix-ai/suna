import { Hono } from 'hono';
import { config, type SandboxProviderName } from '../config';
import { combinedAuth } from '../middleware/auth';
import { preview } from './routes/preview';
import { getAuthToken } from './routes/auth';
import { shareApp } from './routes/share';
import { invalidateSandbox, loadSandbox } from './backend';
import { createSandboxProxyRateLimitMiddleware } from '../shared/rate-limit';

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

// ── Provider resolution (share endpoints) ─────────────────────────────────────
// A thin policy layer over the single backend row loader: the share routes only
// proxy to *active* sandboxes on an allowed provider. The proxy data path
// (forwardToSandbox / resolvePreviewWsUpstream) uses backend.loadSandbox
// directly — there is no separate provider cache anymore.

export type ResolvedProvider = {
  provider: SandboxProviderName;
  baseUrl: string;
  serviceKey: string;
};

export async function resolveProvider(externalId: string): Promise<ResolvedProvider | null> {
  try {
    const record = await loadSandbox(externalId);
    if (!record || record.status !== 'active') return null;
    if (!(config.ALLOWED_SANDBOX_PROVIDERS as readonly string[]).includes(record.provider)) {
      return null;
    }
    return {
      provider: record.provider as SandboxProviderName,
      baseUrl: record.baseUrl,
      serviceKey: record.serviceKey ?? '',
    };
  } catch (err) {
    console.error(`[PREVIEW] Provider lookup failed for ${externalId}:`, err);
    return null;
  }
}

/** Drop cached backend state for a sandbox (called on lifecycle transitions). */
export function invalidateProviderCache(externalId: string): void {
  invalidateSandbox(externalId);
}

// Every sandbox serves from a per-sandbox URL — the preview handler reads it
// from the row (`baseUrl`) or fetches it from Daytona's SDK. No per-provider
// dispatch needed in this thin proxy.
sandboxProxyApp.route('/', preview);

export { sandboxProxyApp };

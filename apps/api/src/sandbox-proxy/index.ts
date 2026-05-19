import { Hono } from 'hono';
import { eq, and } from 'drizzle-orm';
import { sessionSandboxes } from '@kortix/db';
import { config, type SandboxProviderName } from '../config';
import { combinedAuth } from '../middleware/auth';
import { preview, proxyToDaytona } from './routes/preview';
import { getAuthToken } from './routes/auth';
import { shareApp } from './routes/share';
import { db } from '../shared/db';
import { resolvePreviewUserContext } from '../shared/preview-ownership';
import {
  encodeKortixUserContext,
  KORTIX_USER_CONTEXT_HEADER,
} from '../shared/kortix-user-context';
import { createSandboxProxyRateLimitMiddleware } from '../shared/rate-limit';

async function buildSignedUserContextHeader(
  sandboxId: string,
  userId: string | undefined,
  serviceKey: string | undefined,
): Promise<Record<string, string>> {
  if (!userId || !serviceKey) {
    console.log(
      `[PREVIEW] skip sign userId=${userId ?? 'none'} hasServiceKey=${!!serviceKey} sandbox=${sandboxId}`,
    );
    return {};
  }
  const payload = await resolvePreviewUserContext(sandboxId, userId);
  if (!payload) {
    console.log(
      `[PREVIEW] no signed context resolved user=${userId} sandbox=${sandboxId} (denied or anonymous)`,
    );
    return {};
  }
  const signed = encodeKortixUserContext(payload, serviceKey);
  console.log(
    `[PREVIEW] signing X-Kortix-User-Context user=${userId} sandbox=${sandboxId} role=${payload.sandboxRole} tokenPrefix=${signed.slice(0, 16)}`,
  );
  return { [KORTIX_USER_CONTEXT_HEADER]: signed };
}

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

// ── Provider cache ──────────────────────────────────────────────────────────
// Cache sandbox provider lookups (single-table: kortix.session_sandboxes) to
// avoid a DB query on every request. The legacy kortix.sandboxes lookup is
// gone — only sessions create sandboxes now.
type CachedProviderName = SandboxProviderName;
interface ProviderCacheEntry {
  provider: CachedProviderName;
  baseUrl: string;
  serviceKey: string;
  expiresAt: number;
}
const providerCache = new Map<string, ProviderCacheEntry>();
const PROVIDER_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function invalidateProviderCache(externalId: string): void {
  providerCache.delete(externalId);
}

export async function resolveProvider(externalId: string): Promise<{
  provider: CachedProviderName;
  baseUrl: string;
  serviceKey: string;
  // Retained as empty strings so call sites that destructure them keep
  // compiling — the JustAVPS-specific values these used to carry are dead.
  proxyToken: string;
  slug: string;
} | null> {
  const cached = providerCache.get(externalId);
  if (cached && Date.now() < cached.expiresAt) {
    return {
      provider: cached.provider,
      baseUrl: cached.baseUrl,
      serviceKey: cached.serviceKey,
      proxyToken: '',
      slug: '',
    };
  }
  providerCache.delete(externalId);

  try {
    const [row] = await db
      .select({
        provider: sessionSandboxes.provider,
        status: sessionSandboxes.status,
        baseUrl: sessionSandboxes.baseUrl,
        config: sessionSandboxes.config,
      })
      .from(sessionSandboxes)
      .where(and(eq(sessionSandboxes.externalId, externalId), eq(sessionSandboxes.status, 'active')))
      .limit(1);

    if (!row) return null;
    if (!(config.ALLOWED_SANDBOX_PROVIDERS as readonly string[]).includes(row.provider)) return null;

    const provider = row.provider as CachedProviderName;
    const baseUrl = row.baseUrl || '';
    const configJson = (row.config || {}) as Record<string, unknown>;
    const serviceKey = typeof configJson.serviceKey === 'string' ? configJson.serviceKey : '';

    providerCache.set(externalId, {
      provider,
      baseUrl,
      serviceKey,
      expiresAt: Date.now() + PROVIDER_CACHE_TTL_MS,
    });
    return { provider, baseUrl, serviceKey, proxyToken: '', slug: '' };
  } catch (err) {
    console.error(`[PREVIEW] Provider lookup failed for ${externalId}:`, err);
    return null;
  }
}

// Every sandbox serves from a per-sandbox URL — the preview handler reads
// it from the row (`baseUrl`) or fetches it from Daytona's SDK. No
// per-provider dispatch needed in this thin proxy.
sandboxProxyApp.route('/', preview);

// Suppress unused-import warning — `buildSignedUserContextHeader` is exported
// only via the preview handler now, but kept in this file because other
// proxy edges (subdomain routing in src/index.ts) may want to reuse it.
void buildSignedUserContextHeader;
void proxyToDaytona;

export { sandboxProxyApp };

// Expand the aggregate ECS secret before any module reads process.env.
import './environment-secret';

// ─── Observability (must follow environment hydration) ───────────────────────
import './lib/sentry';

import { config } from './config';
import { ensureAbsoluteRequestUrl, getRequestUrl } from './lib/request-url';
import { runInboundAudit } from './shared/audit-edge';
import { describeEmailChain } from './lib/email/transport';
import { initModelPricing } from './router/config/model-pricing';
import { runtimeModelCatalog } from './llm-gateway/models/runtime-catalog';
import { primeDaytonaRateLimitClassifier } from './shared/daytona-rate-limit';
import { primeDaytonaTransientClassifier } from './shared/daytona-transient';
import { ensureSchema } from './ensure-schema';
import { dispatchInbound } from './inbound-dispatch';
import { bootServices, markSchemaReady, shutdown } from './bootstrap';
import { appWsHandlers } from './apps/ws-proxy';
import { wsHandlers as tunnelWsHandlers } from './tunnel';
import { previewWsHandlers } from './sandbox-proxy/ws-proxy';

// The assembled app; the server entry below only serves it.
import { app } from './app';

export { app };

// === Start Server ===

// Pre-load the Daytona SDK's `DaytonaRateLimitError` class so the synchronous
// `isDaytonaRateLimitError` classifier (on the global `app.onError` hot path)
// has its strongest instanceof signal available the first time a 429 throws —
// see shared/daytona-rate-limit.ts. Fire-and-forget: the classifier's
// name/statusCode/message fallbacks already cover the rare race where a 429
// throws before this resolves, so we never block startup on it.
void primeDaytonaRateLimitClassifier();

// Pre-load the Daytona SDK's `DaytonaTimeoutError` / `DaytonaConnectionError`
// classes so the synchronous `isDaytonaTransientProviderError` classifier (on
// the global `app.onError` hot path) has its strongest instanceof signal
// available the first time a transient gateway / connection / timeout failure
// throws — see shared/daytona-transient.ts. Fire-and-forget: the classifier's
// name / statusCode / message fallbacks already cover the rare race where a
// transient failure throws before this resolves, so we never block startup on
// it.
void primeDaytonaTransientClassifier();

console.log(`
╔═══════════════════════════════════════════════════════════╗
║                  Kortix API Starting                      ║
╠═══════════════════════════════════════════════════════════╣
║  Port: ${config.PORT.toString().padEnd(49)}║
║  Env:  ${config.INTERNAL_KORTIX_ENV.padEnd(49)}║
╠═══════════════════════════════════════════════════════════╣
║  Services:                                                ║
║    /v1/router     (search, LLM, proxy)                    ║
║    /v1/billing    (subscriptions, credits, webhooks)       ║
║    /v1/platform   (api keys, sandbox version)               ║
║    /v1/projects   (Git-backed projects)                    ║
║    /v1/setup      (setup & env management)                 ║
║    /v1/tunnel     (reverse-tunnel to local machines)         ║
║    /v1/p         (sandbox proxy — local + cloud)            ║
╠═══════════════════════════════════════════════════════════╣
║  Database:   ${config.DATABASE_URL ? '✓ Configured'.padEnd(42) : '✗ NOT SET'.padEnd(42)}║
║  Supabase:   ${config.SUPABASE_URL ? '✓ Configured'.padEnd(42) : '✗ NOT SET'.padEnd(42)}║
║  Stripe:     ${config.STRIPE_SECRET_KEY ? '✓ Configured'.padEnd(42) : '✗ NOT SET'.padEnd(42)}║
║  Billing:    ${(config.KORTIX_BILLING_INTERNAL_ENABLED ? 'ENABLED' : 'DISABLED').padEnd(42)}║
║  Tunnel:     ${(config.TUNNEL_ENABLED ? 'ENABLED' : 'DISABLED').padEnd(42)}║
║  Providers:  ${config.ALLOWED_SANDBOX_PROVIDERS.join(', ').padEnd(42)}║
╚═══════════════════════════════════════════════════════════╝
`);

// Local REST tests use the bundled model catalog and never contact models.dev.
if (process.env.KORTIX_MODEL_PRICING_LIVE_ENABLED !== '0') {
  await initModelPricing().catch((err) =>
    console.error('[startup] Model pricing init failed (will retry in 24h):', err),
  );
}
if (process.env.KORTIX_MODEL_CATALOG_LIVE_ENABLED !== '0') {
  runtimeModelCatalog
    .start()
    .catch((err) =>
      console.error('[startup] Gateway model catalog init failed (keeping bundled snapshot):', err),
    );
}

// Boot only when this module is the entry point (`bun run src/index.ts`, which
// is how both `pnpm dev` and the Docker CMD launch it). Guarding behind
// import.meta.main lets tooling and tests `import { app }` to introspect the
// route table without starting the DB schema check, background workers, or
// signal handlers. Does NOT change production boot — there, import.meta.main is true.
if (import.meta.main) {
  // One line an operator can grep for when email "does not work": which
  // providers EMAIL_URL resolved to, and the address mail is sent from. Never
  // prints credentials.
  console.log(`[email] ${describeEmailChain()}`);

  ensureSchema()
    .then(async () => {
      markSchemaReady();
      // Role permissions are rows (kortix.role_permissions), so the
      // boot-time system-role seed + membership-policy backfill from V1
      // are no longer needed. Permissions resolve directly from
      // account_members.account_role and project_members.project_role.
      await bootServices();
    })
    .catch(async (err) => {
      console.error('[startup] ensureSchema failed, starting services anyway:', err);
      markSchemaReady();
      await bootServices();
    });

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

export default {
  port: config.PORT,

  // idleTimeout DISABLED (0). Bun's default is 10s and its MAX is 255s, and Bun
  // does NOT reset idleTimeout on server->client writes — so ANY fixed ceiling
  // can kill a legitimately long request (e.g. project provisioning runs ~90s
  // and was being cut at the previous 45s; see provisionProjectWithToken) or a
  // long-poll/SSE surface, returning an EMPTY reply that the LB turns into a
  // 502 with no CORS headers (a bogus browser CORS error). The 25s request
  // deadline middleware remains the PRIMARY guard: a genuinely stuck request
  // still surfaces as a clean 503 (with Retry-After) well before any socket
  // concern. So 0 removes only the redundant backstop while letting legitimate
  // long requests and streams run to completion.
  idleTimeout: 0,

  async fetch(req: Request, server: any): Promise<Response | undefined> {
    // Bun.serve sets `req.url` to a PATH-ONLY string (`"/"`,
    // `"/nice%20ports%2C/Tri%6Eity.txt%2ebak"`, …) for requests that arrive
    // WITHOUT a `Host` header — raw HTTP/1.0 port-scanner probes and malformed
    // clients. Every downstream `new URL(c.req.url)` / `new URL(req.url)`
    // call site (auth middleware, OpenAPI server URL, sandbox preview /
    // public-share proxy, git proxy, Slack/Teams webhook routers, …) assumes
    // an absolute URL and would otherwise throw
    // `TypeError: "…" cannot be parsed as a URL.` → app.onError → Sentry.
    // Rebuild the Request once, here, with the absolute URL so all of those
    // call sites are safe. No-op for normal requests (which already carry an
    // absolute `req.url`). See lib/request-url.ts ensureAbsoluteRequestUrl.
    // BS pattern 28e9a65c… (scanner noise, 0 users, first seen 2026-04-27).
    req = ensureAbsoluteRequestUrl(req, config.PORT);
    const url = getRequestUrl(req, config.PORT);
    return runInboundAudit(req, url, () => dispatchInbound(req, url, server, app));
  },

  websocket: {
    // Disable Bun's default 120s idle timeout — tunnel agents use their own
    // heartbeat mechanism (30s ping/pong) for liveness detection.
    idleTimeout: 0,

    open(ws: {
      data: any;
      send: (data: any) => void;
      close: (code?: number, reason?: string) => void;
    }) {
      if (ws.data?.type === 'tunnel-agent') {
        tunnelWsHandlers.onOpen(ws.data.tunnelId, ws as any);
        return;
      }
      if (ws.data?.type === 'preview-ws') {
        previewWsHandlers.open(ws as any);
        return;
      }
      if (ws.data?.type === 'app-ws') {
        appWsHandlers.open(ws as any);
        return;
      }
      // No other WS upgrades are accepted.
      try {
        ws.close(1011, 'unsupported websocket upgrade');
      } catch {}
    },

    message(
      ws: { data: any; close: (code?: number, reason?: string) => void },
      message: string | Buffer,
    ) {
      if (ws.data?.type === 'tunnel-agent') {
        tunnelWsHandlers.onMessage(ws.data.tunnelId, ws as any, message);
        return;
      }
      if (ws.data?.type === 'preview-ws') {
        previewWsHandlers.message(ws as any, message);
        return;
      }
      if (ws.data?.type === 'app-ws') {
        appWsHandlers.message(ws as any, message);
        return;
      }
    },

    close(ws: { data: any }) {
      if (ws.data?.type === 'tunnel-agent') {
        tunnelWsHandlers.onClose(ws.data.tunnelId, ws as any);
        return;
      }
      if (ws.data?.type === 'preview-ws') {
        previewWsHandlers.close(ws as any);
        return;
      }
      if (ws.data?.type === 'app-ws') {
        appWsHandlers.close(ws as any);
        return;
      }
    },
  },
};

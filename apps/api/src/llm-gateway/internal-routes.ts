import type {
  AuthedPrincipal,
  GatewayTrace,
  ModelRouteInput,
  UsageEvent,
} from '@kortix/llm-gateway';
import { GatewayResolutionError } from '@kortix/llm-gateway';
import { Hono } from 'hono';
import { z } from 'zod';
import { logger } from '../lib/logger';
import { checkBudget } from './budgets';
import {
  authenticatePrincipal,
  assertLlmBillingActive,
  authorizeRequest,
  persistGatewayTrace,
  recordGatewayUsage,
} from './hooks';
import { matchesInternalToken, weakInternalTokenWarnings } from './internal-auth';
import { gatewayModelCatalog } from './models/catalog-models';
import { servableProjectCatalog } from './models/servable-catalog';
import { resolveCandidates } from './resolution/resolve-candidates';
import { coolDownAccountSecret } from '../secrets/account-resource';
import { resolveGatewayRoute } from './routing';

// HTTP control plane for the OUT-OF-PROCESS gateway pod. Every handler is a thin
// wrapper over the shared in-process hooks in ./hooks — the standalone service
// and the in-API mount run identical logic; only the transport (HTTP vs direct
// call) differs.
export function createInternalGatewayRoutes() {
  const app = new Hono();
  const internalToken = process.env.GATEWAY_INTERNAL_TOKEN;

  for (const warning of weakInternalTokenWarnings(internalToken)) {
    logger.warn(`[gateway-internal-auth] ${warning}`);
  }

  app.use('*', async (c, next) => {
    if (!internalToken) return c.json({ error: 'internal gateway disabled' }, 503);
    if (!matchesInternalToken(c.req.header('authorization'), internalToken)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    return next();
  });

  app.post('/authenticate', async (c) => {
    const { token } = await c.req.json();
    if (typeof token !== 'string' || !token) return c.json({ principal: null });
    return c.json({ principal: await authenticatePrincipal(token) });
  });

  // Combined authentication + budget gate. Billing runs after model resolution.
  app.post('/authorize', async (c) => {
    const { token, deferBilling } = await c.req.json();
    if (typeof token !== 'string' || !token) {
      return c.json({
        ok: false,
        status: 401,
        errorCode: 'invalid_token',
        message: 'Invalid token',
      });
    }
    return c.json(await authorizeRequest(token, { deferBilling: deferBilling === true }));
  });

  app.post('/resolve-upstream', async (c) => {
    const { principal, model } = await c.req.json();
    try {
      const candidates = await resolveCandidates(
        principal as AuthedPrincipal,
        typeof model === 'string' ? model : '',
      );
      return c.json({ candidates });
    } catch (err) {
      // resolveCandidates throws a GatewayResolutionError (instead of returning
      // []) when it can pin down WHY there's no upstream — provider_not_connected
      // ("Connect Codex to use this model."), plan_upgrade_required, expired
      // Codex OAuth, model_disabled_on_deployment, model_not_found. These are
      // EXPECTED, user-facing resolution outcomes the gateway pipeline is
      // designed to catch and surface as a clean 400 with an actionable
      // suggestion (see packages/llm-gateway/src/pipeline/handler.ts's dispatch
      // loop, which treats a thrown GatewayResolutionError as "no candidates,
      // with a reason"). Letting it propagate here would (a) turn an expected
      // 4xx into a 500 to the gateway pod, (b) get captured to Sentry/Better
      // Stack Errors as an unhandled exception (the "Connect Codex" spike,
      // incident 991624588), and (c) be retried 3x by the api-client. Instead,
      // return the typed error in a 200 body so the api-client can re-throw it
      // as a GatewayResolutionError and the in-process hook contract holds.
      if (err instanceof GatewayResolutionError) {
        logger.warn(`[gateway-internal] resolution failed for "${model}": ${err.code} — ${err.message}`);
        return c.json({
          candidates: [],
          resolutionError: { code: err.code, message: err.message, suggestion: err.suggestion, retryAfterSeconds: err.retryAfterSeconds },
        });
      }
      throw err;
    }
  });

  app.post('/pool-rate-limit', async (c) => {
    const parsed = z.object({
      principal: z.object({ accountId: z.string().uuid(), sessionId: z.string().uuid() }),
      secretId: z.string().uuid(), seconds: z.number().int().min(1).max(60),
    }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Invalid pool rate limit' }, 400);
    await coolDownAccountSecret(parsed.data.secretId, parsed.data.principal.accountId, parsed.data.seconds);
    return c.json({ ok: true });
  });

  app.post('/resolve-route', async (c) => {
    const { principal, input } = await c.req.json();
    const route = await resolveGatewayRoute(principal as AuthedPrincipal, input as ModelRouteInput);
    return c.json({ route });
  });

  app.post('/budget-check', async (c) => {
    const { principal } = await c.req.json();
    return c.json(await checkBudget(principal as AuthedPrincipal));
  });

  app.post('/models', async (c) => {
    const { principal, managedOnly, scope } = await c.req.json();
    const p = principal as AuthedPrincipal;
    // `scope:'picker'` backs the standalone gateway's `GET /models?scope=picker`:
    // the project's SERVABLE set (managed the account may use + connected BYOK
    // + routing-named ids, ~80KB) — what the web picker shows and what a
    // sandbox registers on its `kortix` provider at boot. Same composition as
    // `GET /projects/:id/model-picker` (servableProjectCatalog).
    if (scope === 'picker' && p.projectId) {
      const catalog = await servableProjectCatalog({
        projectId: p.projectId,
        accountId: p.accountId,
        principalUserId: p.personalUserId === undefined ? p.userId : p.personalUserId,
      });
      return c.json({ models: catalog.models });
    }
    // `managedOnly` backs the standalone gateway's `GET /models?scope=managed`
    // — the compact managed lineup a sandbox fetches on boot. Dropping the
    // projectId is what selects MANAGED_ONLY; free-tier accounts still get an
    // empty managed set.
    return c.json({
      models: gatewayModelCatalog(managedOnly === true ? undefined : p.projectId, {
        freeManagedOnly: !!p.freeModelsOnly,
      }),
    });
  });

  app.post('/billing', async (c) => {
    const { accountId } = await c.req.json();
    try {
      const result = await assertLlmBillingActive(accountId);
      return c.json({ active: true, holdUsd: result?.holdUsd });
    } catch (err) {
      return c.json({
        active: false,
        reason: typeof (err as { reason?: unknown })?.reason === 'string'
          ? (err as { reason: string }).reason
          : 'subscription_required',
        message: err instanceof Error ? err.message : 'subscription required',
      });
    }
  });

  app.post('/usage', async (c) => {
    const { event } = await c.req.json();
    // `requestId` is the settlement's idempotency key (one usage row, one
    // debit, one refund per request). Without it a retry would bill twice.
    if (
      !event ||
      typeof event !== 'object' ||
      typeof event.accountId !== 'string' ||
      typeof event.requestId !== 'string' ||
      !event.requestId
    ) {
      return c.json({ ok: false, error: 'event.accountId and event.requestId are required' }, 400);
    }
    await recordGatewayUsage(event as UsageEvent);
    return c.json({ ok: true });
  });

  app.post('/trace', async (c) => {
    const { trace } = await c.req.json();
    if (!trace || typeof trace.requestId !== 'string') return c.json({ ok: false }, 400);
    // Trace persistence is best-effort observability — never 500 the gateway's
    // fire-and-forget trace post if the write fails.
    try {
      await persistGatewayTrace(trace as GatewayTrace);
    } catch (err) {
      logger.warn(`[gateway] persistGatewayTrace failed for ${trace.requestId}`, {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ ok: false }, 200);
    }
    return c.json({ ok: true });
  });

  return app;
}

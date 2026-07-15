import type {
  AuthedPrincipal,
  GatewayTrace,
  ModelRouteInput,
  UsageEvent,
} from '@kortix/llm-gateway';
import { Hono } from 'hono';
import { assertBillingActive } from '../billing/services/billing-gate';
import { checkBudget } from './budgets';
import {
  authenticatePrincipal,
  authorizeRequest,
  persistGatewayTrace,
  recordGatewayUsage,
} from './hooks';
import { matchesInternalToken } from './internal-auth';
import { gatewayModelCatalog } from './models/catalog-models';
import { resolveCandidates } from './resolution/resolve-candidates';
import { resolveGatewayRoute } from './routing';
import { logger } from '../lib/logger';

// HTTP control plane for the OUT-OF-PROCESS gateway pod. Every handler is a thin
// wrapper over the shared in-process hooks in ./hooks — the standalone service
// and the in-API mount run identical logic; only the transport (HTTP vs direct
// call) differs.
export function createInternalGatewayRoutes() {
  const app = new Hono();
  const internalToken = process.env.GATEWAY_INTERNAL_TOKEN;

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

  // Combined gate (auth + billing + budget) — lets the standalone gateway fold
  // three sequential RPCs into one on the chat-completions hot path.
  app.post('/authorize', async (c) => {
    const { token } = await c.req.json();
    if (typeof token !== 'string' || !token) {
      return c.json({
        ok: false,
        status: 401,
        errorCode: 'invalid_token',
        message: 'Invalid token',
      });
    }
    return c.json(await authorizeRequest(token));
  });

  app.post('/resolve-upstream', async (c) => {
    const { principal, model } = await c.req.json();
    const candidates = await resolveCandidates(
      principal as AuthedPrincipal,
      typeof model === 'string' ? model : '',
    );
    return c.json({ candidates });
  });

  app.post('/resolve-route', async (c) => {
    const { principal, input } = await c.req.json();
    const route = await resolveGatewayRoute(
      principal as AuthedPrincipal,
      input as ModelRouteInput,
    );
    return c.json({ route });
  });

  app.post('/budget-check', async (c) => {
    const { principal } = await c.req.json();
    return c.json(await checkBudget(principal as AuthedPrincipal));
  });

  app.post('/models', async (c) => {
    const { principal } = await c.req.json();
    const p = principal as AuthedPrincipal;
    return c.json({
      models: gatewayModelCatalog(p.projectId, {
        freeManagedOnly: !!p.freeModelsOnly,
      }),
    });
  });

  app.post('/billing', async (c) => {
    const { accountId } = await c.req.json();
    try {
      await assertBillingActive(accountId);
      return c.json({ active: true });
    } catch (err) {
      return c.json({
        active: false,
        message: err instanceof Error ? err.message : 'subscription required',
      });
    }
  });

  app.post('/usage', async (c) => {
    const { event } = await c.req.json();
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

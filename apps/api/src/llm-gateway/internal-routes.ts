import { Hono } from 'hono';
import type { AuthedPrincipal } from '@kortix/llm-gateway';
import { assertBillingActive } from '../billing/services/billing-gate';
import { deductForLlmUsage } from '../billing/services/credits';
import { llmPriceMarkup } from '../billing/services/tiers';
import { attributeYoloToken } from '../billing/services/yolo-tokens';
import { validateAccountToken } from '../repositories/account-tokens';
import { recordUsageEvent } from '../shared/usage-events';
import { recordGatewayTrace } from '../shared/gateway-logs';
import { config } from '../config';
import { resolveCandidates } from './resolution/resolve-candidates';
import { gatewayModelCatalog } from './models/catalog-models';
import { checkBudget } from './budgets';
import { validateGatewayKey } from './gateway-keys';
import { isGatewayKey } from '../shared/crypto';

export function createInternalGatewayRoutes() {
  const app = new Hono();
  const internalToken = process.env.GATEWAY_INTERNAL_TOKEN;

  app.use('*', async (c, next) => {
    if (!internalToken) return c.json({ error: 'internal gateway disabled' }, 503);
    if (c.req.header('authorization') !== `Bearer ${internalToken}`) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    return next();
  });

  app.post('/authenticate', async (c) => {
    const { token } = await c.req.json();
    if (typeof token !== 'string' || !token) return c.json({ principal: null });

    if (isGatewayKey(token)) {
      const key = await validateGatewayKey(token);
      return c.json({ principal: key });
    }

    const yolo = await attributeYoloToken(token);
    if (yolo) return c.json({ principal: yolo });

    const account = await validateAccountToken(token);
    if (account.isValid && account.userId && account.accountId) {
      return c.json({
        principal: {
          userId: account.userId,
          accountId: account.accountId,
          projectId: account.projectId ?? undefined,
          sessionId: account.sessionId ?? undefined,
        },
      });
    }
    return c.json({ principal: null });
  });

  app.post('/resolve-upstream', async (c) => {
    const { principal, model } = await c.req.json();
    const candidates = await resolveCandidates(principal as AuthedPrincipal, typeof model === 'string' ? model : '');
    return c.json({ candidates });
  });

  app.post('/budget-check', async (c) => {
    const { principal } = await c.req.json();
    const result = await checkBudget(principal as AuthedPrincipal);
    return c.json(result);
  });

  app.post('/models', async (c) => {
    const { principal } = await c.req.json();
    const p = principal as AuthedPrincipal;
    const models = await gatewayModelCatalog(p.projectId, p.userId);
    return c.json({ models });
  });

  app.post('/billing', async (c) => {
    const { accountId } = await c.req.json();
    try {
      await assertBillingActive(accountId);
      return c.json({ active: true });
    } catch (err) {
      return c.json({ active: false, message: err instanceof Error ? err.message : 'subscription required' });
    }
  });

  app.post('/usage', async (c) => {
    const { event } = await c.req.json();
    const usageEventId = await recordUsageEvent({
      accountId: event.accountId,
      actorUserId: event.actorUserId,
      provider: event.provider,
      model: event.model,
      route: '/v1/llm/chat/completions',
      inputTokens: event.promptTokens,
      outputTokens: event.completionTokens,
      cachedTokens: event.cachedTokens,
      costUsd: event.finalCost,
      streaming: event.streaming,
      metadata: {
        upstreamCostUsd: event.upstreamCost,
        markup: llmPriceMarkup(),
        requestId: event.requestId,
        billingMode: event.billingMode,
      },
    });

    if (config.KORTIX_BILLING_INTERNAL_ENABLED && event.billingMode !== 'none') {
      await deductForLlmUsage({
        accountId: event.accountId,
        costUsd: event.finalCost,
        model: event.model,
        provider: event.provider,
        actorUserId: event.actorUserId,
        usageEventId,
        upstreamCostUsd: event.upstreamCost,
        markup: llmPriceMarkup(),
      });
    }
    return c.json({ ok: true });
  });

  app.post('/trace', async (c) => {
    const { trace } = await c.req.json();
    if (!trace || typeof trace.requestId !== 'string') {
      return c.json({ ok: false }, 400);
    }
    if (!trace.accountId) {
      return c.json({ ok: true });
    }
    await recordGatewayTrace({
      requestId: trace.requestId,
      accountId: trace.accountId,
      projectId: trace.projectId,
      sessionId: trace.sessionId,
      actorUserId: trace.actorUserId,
      keyId: trace.keyId,
      requestedModel: trace.requestedModel ?? '',
      resolvedModel: trace.resolvedModel ?? trace.requestedModel ?? '',
      provider: trace.provider ?? '',
      status: typeof trace.status === 'number' ? trace.status : 0,
      ok: Boolean(trace.ok),
      errorCode: trace.errorCode,
      errorMessage: trace.errorMessage,
      latencyMs: trace.latencyMs,
      attempts: trace.attempts,
      candidatesTried: Array.isArray(trace.candidatesTried) ? trace.candidatesTried : [],
      promptTokens: trace.usage?.promptTokens,
      completionTokens: trace.usage?.completionTokens,
      cachedTokens: trace.usage?.cachedTokens,
      upstreamCost: trace.upstreamCost,
      finalCost: trace.finalCost,
      streaming: trace.streaming,
      billingMode: trace.billingMode,
      request: trace.request,
      response: trace.response,
      metadata: trace.metadata,
    });
    return c.json({ ok: true });
  });

  return app;
}

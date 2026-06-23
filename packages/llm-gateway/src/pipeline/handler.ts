import type {
  GatewayConfig,
  GatewayHooks,
  GatewayLogger,
  TokenCounts,
  UsageEvent,
} from '../domain';
import type { FetchImpl } from '../http';
import type { CircuitBreaker } from '../resilience';
import { type ExtractedUsage, calculateCost, extractUsageFromJson } from '../usage';
import { runFailover } from './failover';
import { relayStream } from './streaming';
import { createTraceEmitter } from './trace';

export interface ChatCompletionRequest {
  authorization: string | undefined;
  rawBody: string;
}

export interface GatewayDeps {
  fetchImpl?: FetchImpl;
  logger?: GatewayLogger;
}

export interface HandlerRuntime {
  hooks: GatewayHooks;
  config: GatewayConfig;
  logger: GatewayLogger;
  fetchImpl?: FetchImpl;
  captureBodies: boolean;
  capture: (value: unknown) => unknown;
  breakerFor: (provider: string) => CircuitBreaker;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function bearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(\S.*)$/i);
  return match ? match[1].trim() : null;
}

function newRequestId(): string {
  return `req_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function handleChatCompletions(
  runtime: HandlerRuntime,
  req: ChatCompletionRequest,
): Promise<Response> {
  const { hooks, config, logger, fetchImpl, captureBodies, capture, breakerFor } = runtime;

  const requestId = newRequestId();
  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  const emit = createTraceEmitter(hooks, logger, requestId, startedAt, startMs);

  let lastMark = startMs;
  const lap = (): number => {
    const now = Date.now();
    const delta = now - lastMark;
    lastMark = now;
    return delta;
  };
  const step = (event: string, fields?: Record<string, unknown>): void =>
    logger.debug?.(`[gateway] · ${requestId} ${event}`, {
      requestId,
      event,
      sinceStartMs: Date.now() - startMs,
      ...fields,
    });

  step('received', { bytes: req.rawBody.length, hasAuthHeader: Boolean(req.authorization) });

  const token = bearer(req.authorization);
  if (!token) {
    step('reject_no_token');
    emit({ status: 401, ok: false, errorCode: 'missing_token' });
    return json({ error: 'Missing bearer token' }, 401);
  }

  const principal = await hooks.authenticate(token);
  if (!principal) {
    step('auth_failed', { ms: lap() });
    emit({ status: 401, ok: false, errorCode: 'invalid_token' });
    return json({ error: 'Invalid token' }, 401);
  }
  step('authenticated', {
    ms: lap(),
    accountId: principal.accountId,
    projectId: principal.projectId,
    userId: principal.userId,
    keyId: principal.keyId,
  });

  const id = {
    accountId: principal.accountId,
    actorUserId: principal.userId,
    projectId: principal.projectId,
    sessionId: principal.sessionId,
    keyId: principal.keyId,
  };

  try {
    await hooks.assertBillingActive(principal.accountId);
    step('billing_ok', { ms: lap() });
  } catch (err) {
    step('billing_inactive', { ms: lap(), reason: errorMessage(err) });
    emit({
      ...id,
      status: 402,
      ok: false,
      errorCode: 'subscription_required',
      errorMessage: errorMessage(err),
    });
    const message = err instanceof Error ? err.message : 'Billing inactive';
    return json({ error: message, message, code: 'subscription_required' }, 402);
  }

  if (hooks.assertBudget) {
    try {
      await hooks.assertBudget(principal);
      step('budget_ok', { ms: lap() });
    } catch (err) {
      step('budget_exceeded', { ms: lap(), reason: errorMessage(err) });
      // 402, not 429: a budget cap is a terminal condition (it won't clear by
      // waiting), so it must NOT be retried like a transient rate limit. Mirrors
      // the billing-inactive gate above.
      emit({
        ...id,
        status: 402,
        ok: false,
        errorCode: 'budget_exceeded',
        errorMessage: errorMessage(err),
      });
      const message = err instanceof Error ? err.message : 'Budget exceeded';
      return json({ error: message, message, code: 'budget_exceeded' }, 402);
    }
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(req.rawBody) as Record<string, unknown>;
  } catch {
    step('invalid_json');
    emit({ ...id, status: 400, ok: false, errorCode: 'invalid_json' });
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const requestedModel = typeof body.model === 'string' ? body.model : '';
  step('body_parsed', {
    model: requestedModel,
    stream: body.stream === true,
    messages: Array.isArray(body.messages) ? body.messages.length : 0,
    tools: Array.isArray(body.tools) ? body.tools.length : 0,
  });
  const metadata =
    body.metadata && typeof body.metadata === 'object'
      ? (body.metadata as Record<string, unknown>)
      : {};

  logger.info(
    `[gateway] → ${requestId} ${requestedModel || '(no model)'}${body.stream === true ? ' stream' : ''} acct=${principal.accountId.slice(0, 8)}`,
  );

  const candidates = await hooks.resolveUpstream(principal, requestedModel);
  step('resolved_candidates', {
    ms: lap(),
    count: candidates.length,
    candidates: candidates.map((c) => ({
      provider: c.provider,
      kind: c.kind,
      resolvedModel: c.resolvedModel,
      billingMode: c.billingMode,
    })),
  });
  if (!candidates.length) {
    step('model_unavailable', { model: requestedModel });
    emit({
      ...id,
      requestedModel,
      status: 400,
      ok: false,
      errorCode: 'model_unavailable',
      request: capture(body),
      metadata,
    });
    return json(
      { error: `No upstream configured for model "${requestedModel}"`, code: 'model_unavailable' },
      400,
    );
  }

  const streaming = body.stream === true;
  const hasReasoning =
    body.reasoning !== undefined ||
    body.reasoning_effort !== undefined ||
    body.thinking !== undefined;
  if (!hasReasoning && config.injectReasoningFor?.(requestedModel)) {
    body.reasoning = { effort: 'medium' };
  }
  const payload = streaming
    ? { ...body, stream: true, stream_options: { include_usage: true } }
    : body;

  step('dispatch_upstream', { streaming, candidateCount: candidates.length });
  const result = await runFailover({
    candidates,
    payload,
    config,
    fetchImpl,
    breakerFor,
    emit,
    logger,
    requestId,
    trace: { ...id, requestedModel, streaming, metadata },
    capturedRequest: capture(payload),
  });

  if (result.kind === 'response') {
    step('upstream_failed', { ms: lap(), status: result.response.status });
    return result.response;
  }

  const { upstream, chosen: descriptor, tried, attempts } = result.value;
  step('upstream_ok', {
    ms: lap(),
    provider: descriptor.provider,
    resolvedModel: descriptor.resolvedModel,
    upstreamStatus: upstream.status,
    attempts,
    tried,
  });

  const settle = async (usage: ExtractedUsage | null, response: unknown): Promise<void> => {
    const usedModel = (
      usage?.model ??
      descriptor.resolvedModel ??
      requestedModel ??
      'unknown'
    ).toString();
    const counts: TokenCounts = {
      promptTokens: usage?.promptTokens ?? 0,
      completionTokens: usage?.completionTokens ?? 0,
      cachedTokens: usage?.cachedTokens ?? 0,
    };
    const markup = descriptor.billingMode === 'none' ? 0 : descriptor.markup;
    const { upstreamCost, finalCost } = calculateCost(
      usedModel,
      counts,
      markup,
      usage?.upstreamCostHint,
      descriptor.pricing,
    );

    if (counts.promptTokens + counts.completionTokens > 0) {
      const event: UsageEvent = {
        ...counts,
        accountId: principal.accountId,
        actorUserId: principal.userId,
        provider: descriptor.provider,
        model: usedModel,
        upstreamCost,
        finalCost,
        billingMode: descriptor.billingMode,
        streaming,
        requestId,
      };
      try {
        await hooks.recordUsage(event);
      } catch (err) {
        logger.warn(`[llm-gateway] recordUsage failed for ${requestId}:`, err);
      }
    }

    step('settled', {
      resolvedModel: usedModel,
      provider: descriptor.provider,
      promptTokens: counts.promptTokens,
      completionTokens: counts.completionTokens,
      cachedTokens: counts.cachedTokens,
      upstreamCost,
      finalCost,
      streaming,
    });

    emit({
      ...id,
      requestedModel,
      resolvedModel: usedModel,
      provider: descriptor.provider,
      billingMode: descriptor.billingMode,
      streaming,
      status: 200,
      ok: true,
      attempts,
      candidatesTried: tried,
      usage: counts,
      upstreamCost,
      finalCost,
      request: capture(payload),
      response: capture(response),
      metadata,
    });
  };

  if (!streaming) {
    const data = await upstream.json();
    step('non_stream_body', { ms: lap() });
    void settle(extractUsageFromJson(data), data);
    return json(data);
  }

  if (!upstream.body) {
    step('empty_stream');
    void settle(null, null);
    return json({ error: 'Upstream returned an empty stream' }, 502);
  }

  step('stream_begin');

  const readable = relayStream({
    upstreamBody: upstream.body,
    captureBodies,
    requestId,
    logger,
    settle,
  });

  return new Response(readable, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  });
}

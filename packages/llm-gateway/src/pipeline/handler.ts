import type {
  AuthedPrincipal,
  AuthorizeResult,
  GatewayConfig,
  GatewayHooks,
  GatewayLogger,
  ModelRoutePlan,
  TokenCounts,
  UpstreamDescriptor,
  UsageEvent,
} from '../domain';
import type { FetchImpl } from '../http';
import { type CircuitBreaker, backoffDelay, realSleep } from '../resilience';
import {
  type ExtractedUsage,
  type SseErrorFrame,
  calculateCost,
  extractUsageFromJson,
  jsonHasContent,
} from '../usage';
import { gatewayErrorBody, gatewayErrorResponse } from './error-response';
import { type RoutedUpstreamCandidate, runFailover } from './failover';
import { type StreamProbeResult, probeStream, relayStream } from './streaming';
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

function requestHasImage(body: Record<string, unknown>): boolean {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return messages.some((message) => {
    if (!message || typeof message !== 'object') return false;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) return false;
    return content.some((part) => {
      if (!part || typeof part !== 'object') return false;
      const type = (part as { type?: unknown }).type;
      return type === 'image_url' || type === 'input_image' || type === 'image';
    });
  });
}

// An empty completion is often a transient upstream hiccup on one specific
// backend (observed: OpenRouter intermittently routing a request to a backend
// that returns an immediate empty `stop` with zero usage, while the very next
// request to the SAME candidate succeeds normally). Retrying the same candidate
// a few times — before falling over to a different candidate, and before ever
// giving up — resolves the overwhelming majority of these transparently,
// including the common case where there is only one candidate to begin with.
const MAX_EMPTY_COMPLETION_ATTEMPTS_PER_CANDIDATE = 3;

function idOf(principal: AuthedPrincipal) {
  return {
    accountId: principal.accountId,
    actorUserId: principal.userId,
    projectId: principal.projectId,
    sessionId: principal.sessionId,
    keyId: principal.keyId,
  };
}

// The pre-dispatch gate: token → authenticated + billing-active + within-budget.
// Uses the host's combined `authorize` hook when present (one call), else the
// granular authenticate + assertBillingActive + assertBudget hooks. Returns a
// uniform AuthorizeResult so the handler renders one response/trace either way.
async function admit(
  hooks: GatewayHooks,
  token: string,
  lap: () => number,
  step: (event: string, fields?: Record<string, unknown>) => void,
): Promise<AuthorizeResult> {
  if (hooks.authorize) {
    const outcome = await hooks.authorize(token);
    if (!outcome.ok) step('authorize_denied', { ms: lap(), code: outcome.errorCode });
    else step('authorized', { ms: lap() });
    return outcome;
  }

  const principal = await hooks.authenticate(token);
  if (!principal) {
    step('auth_failed', { ms: lap() });
    return { ok: false, status: 401, errorCode: 'invalid_token', message: 'Invalid token' };
  }

  try {
    await hooks.assertBillingActive(principal.accountId);
    step('billing_ok', { ms: lap() });
  } catch (err) {
    step('billing_inactive', { ms: lap(), reason: errorMessage(err) });
    return {
      ok: false,
      status: 402,
      errorCode: 'subscription_required',
      message: err instanceof Error ? err.message : 'Billing inactive',
      principal,
    };
  }

  if (hooks.assertBudget) {
    try {
      await hooks.assertBudget(principal);
      step('budget_ok', { ms: lap() });
    } catch (err) {
      step('budget_exceeded', { ms: lap(), reason: errorMessage(err) });
      // 402, not 429: a budget cap is terminal (it won't clear by waiting), so it
      // must NOT be retried like a transient rate limit. Mirrors the billing gate.
      return {
        ok: false,
        status: 402,
        errorCode: 'budget_exceeded',
        message: err instanceof Error ? err.message : 'Budget exceeded',
        principal,
      };
    }
  }

  return { ok: true, principal };
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
    return gatewayErrorResponse(401, {
      message: 'Missing bearer token', code: 'missing_token', provider: '',
      requestedModel: '', resolvedModel: '', requestId,
      suggestion: 'Sign in again or provide a valid API token, then retry.',
    });
  }

  // Pre-dispatch gate: authenticate + billing + budget. When the host provides a
  // combined `authorize` hook (the standalone gateway, folding three sequential
  // cross-process RPCs into one), use it; otherwise run the granular hooks (the
  // in-process mount, where the three direct calls are free). Both yield the same
  // outcome: a principal, or a 401/402 denial with the same response + trace.
  const gate = await admit(hooks, token, lap, step);
  if (!gate.ok) {
    const denyId = gate.principal ? idOf(gate.principal) : {};
    emit({
      ...denyId,
      status: gate.status,
      ok: false,
      errorCode: gate.errorCode,
      errorMessage: gate.message,
    });
    const message = gate.message ?? 'Unauthorized';
    return gatewayErrorResponse(gate.status, {
      message, code: gate.errorCode, provider: '', requestedModel: '', resolvedModel: '', requestId,
      suggestion: gate.status === 401
        ? 'Sign in again or provide a valid API token, then retry.'
        : 'Check account billing and budget settings, or use another available model.',
    });
  }
  const principal = gate.principal;
  step('authenticated', {
    ms: lap(),
    accountId: principal.accountId,
    projectId: principal.projectId,
    userId: principal.userId,
    keyId: principal.keyId,
  });

  const id = idOf(principal);

  // Reject oversized bodies before the JSON parse and upstream dispatch. Off by
  // default (`maxRequestBytes` unset/0); when configured it turns an upstream
  // that silently drops an over-limit request into an immediate, actionable 413
  // instead of a multi-second retry storm that ends in a generic 502.
  if (config.maxRequestBytes && req.rawBody.length > config.maxRequestBytes) {
    step('request_too_large', { bytes: req.rawBody.length, limit: config.maxRequestBytes });
    emit({
      ...id,
      status: 413,
      ok: false,
      errorCode: 'request_too_large',
      errorMessage: `Request body ${req.rawBody.length} bytes exceeds limit ${config.maxRequestBytes}`,
    });
    return gatewayErrorResponse(413, {
      message: `Request body of ${req.rawBody.length} bytes exceeds the ${config.maxRequestBytes}-byte limit`,
      code: 'request_too_large', provider: '', requestedModel: '', resolvedModel: '', requestId,
      suggestion: 'Start a new session or reduce the conversation and attachment size, then retry.',
    });
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(req.rawBody) as Record<string, unknown>;
  } catch {
    step('invalid_json');
    emit({ ...id, status: 400, ok: false, errorCode: 'invalid_json' });
    return gatewayErrorResponse(400, {
      message: 'Invalid JSON body', code: 'invalid_json', provider: '',
      requestedModel: '', resolvedModel: '', requestId,
      suggestion: 'Correct the request body and retry.',
    });
  }

  const requestedModel = typeof body.model === 'string' ? body.model : '';
  // Model names, defaults, catalog availability, and fallback policy belong to
  // the host/control plane. The gateway sends only the requested id and minimal
  // capability traits, then executes the returned finite route generically.
  let route: ModelRoutePlan | null;
  try {
    route = await hooks.resolveRoute?.(principal, {
      requestedModel,
      requires: { imageInput: requestHasImage(body) },
    }) ?? null;
  } catch (err) {
    const message = errorMessage(err);
    step('route_resolution_failed', { ms: lap(), error: message });
    emit({
      ...id,
      requestedModel,
      resolvedModel: requestedModel,
      status: 502,
      ok: false,
      errorCode: 'routing_unavailable',
      errorMessage: message,
      request: capture(body),
    });
    return gatewayErrorResponse(502, {
      message: 'Model routing policy is unavailable',
      code: 'routing_unavailable',
      provider: '',
      requestedModel,
      resolvedModel: requestedModel,
      requestId,
      suggestion: 'Retry the request. If the error continues, check the gateway control plane.',
    });
  }
  const routedModel = route?.primaryModel || requestedModel;
  if (routedModel !== requestedModel) {
    body.model = routedModel;
  }
  step('body_parsed', {
    model: requestedModel,
    routedModel,
    stream: body.stream === true,
    messages: Array.isArray(body.messages) ? body.messages.length : 0,
    tools: Array.isArray(body.tools) ? body.tools.length : 0,
  });
  const metadata =
    body.metadata && typeof body.metadata === 'object'
      ? (body.metadata as Record<string, unknown>)
      : {};

  logger.info(
    `[gateway] → ${requestId} ${requestedModel || '(no model)'}${routedModel !== requestedModel ? ` →${routedModel}` : ''}${body.stream === true ? ' stream' : ''} acct=${principal.accountId.slice(0, 8)}`,
  );

  const maxFallbackModels = Math.min(8, Math.max(0, config.maxFallbackModels ?? 3));
  const routeModels = [
    routedModel,
    ...(route?.fallbackModels ?? []).filter((model): model is string =>
      typeof model === 'string' && model.length > 0,
    ),
  ]
    .filter((model, index, all) => all.indexOf(model) === index)
    .slice(0, maxFallbackModels + 1);
  const fallbackOn = route?.fallbackOn ?? 'transient';
  const routingMetadata = (selected: string | null): Record<string, unknown> =>
    routeModels.length > 1
      ? {
          ...metadata,
          gatewayRouting: {
            policy: route?.policyId || 'control-plane',
            models: routeModels,
            selected,
          },
        }
      : metadata;
  const candidates: RoutedUpstreamCandidate[] = [];
  for (const routeModel of routeModels) {
    try {
      const resolved = await hooks.resolveUpstream(principal, routeModel);
      candidates.push(...resolved.map((descriptor) => ({ descriptor, routeModel })));
    } catch (err) {
      // Resolution can itself fail (for example, an expired Codex credential
      // that cannot refresh). A configured model policy treats that like an
      // unavailable candidate and continues to the next finite fallback.
      logger.warn(`[llm-gateway] model resolution failed for ${routeModel} ${requestId}:`, err);
      step('model_resolution_failed', { routeModel, error: errorMessage(err) });
    }
  }
  step('resolved_candidates', {
    ms: lap(),
    count: candidates.length,
    routeModels,
    fallbackOn,
    candidates: candidates.map(({ descriptor, routeModel }) => ({
      routeModel,
      provider: descriptor.provider,
      kind: descriptor.kind,
      resolvedModel: descriptor.resolvedModel,
      billingMode: descriptor.billingMode,
    })),
  });
  if (!candidates.length) {
    step('model_unavailable', { model: requestedModel, routedModel });
    emit({
      ...id,
      requestedModel,
      resolvedModel: routedModel,
      status: 400,
      ok: false,
      errorCode: 'model_unavailable',
      request: capture(body),
      metadata: routingMetadata(null),
    });
    return gatewayErrorResponse(400, {
      message: `No upstream configured for model "${routedModel}"`, code: 'model_unavailable',
      provider: '', requestedModel, resolvedModel: routedModel, requestId,
      suggestion: 'Choose another model or connect the required provider, then retry.',
    });
  }

  const streaming = body.stream === true;
  // Client-supplied reasoning/thinking passes through verbatim (honored by the
  // openai-compat and openai-responses transports). The gateway does NOT force a
  // default reasoning effort: it's the client's (opencode's) decision, it costs
  // reasoning tokens, and the Bedrock/Anthropic transports build their own
  // payloads and would silently ignore a top-level `reasoning` field anyway.
  const payload = streaming
    ? { ...body, stream: true, stream_options: { include_usage: true } }
    : body;

  step('dispatch_upstream', { streaming, candidateCount: candidates.length, routeModels });

  // An upstream can return a syntactically valid 200 with empty `choices`/content
  // (seen from OpenRouter/z-ai) — a real failure mode, not a legitimate zero-output
  // turn. That never throws, so runFailover's transport-level retry/failover never
  // sees it. This loop adds a second failover tier on top: each candidate gets a
  // few immediate retries in place (below), and only once it's exhausted its own
  // retries is it excluded so the remaining candidates get a turn — only once
  // every candidate has produced nothing do we give up and tell the caller,
  // instead of silently forwarding a blank "stop".
  const exhaustedCandidates = new Set<string>();
  const emptyAttemptsByCandidate = new Map<string, number>();
  const candidateKey = ({ descriptor, routeModel }: RoutedUpstreamCandidate): string =>
    `${routeModel}\u0000${descriptor.provider}\u0000${descriptor.resolvedModel ?? ''}`;
  const sleep = config.retry?.sleep ?? realSleep;
  const rand = config.retry?.rand ?? Math.random;
  const baseDelayMs = config.retry?.baseDelayMs ?? 250;
  const maxDelayMs = config.retry?.maxDelayMs ?? 8_000;
  const jitter = config.retry?.jitter ?? true;

  // Records an empty completion from a routed candidate. Retries it (via
  // a short backoff, then `continue`) while it's under budget; once exhausted,
  // excludes it from `remaining` so the loop moves on to the next candidate (or
  // to the all-candidates-empty exit if there isn't one).
  const registerEmptyCompletion = async (
    candidate: RoutedUpstreamCandidate,
    fields: Record<string, unknown>,
  ): Promise<void> => {
    const key = candidateKey(candidate);
    const { descriptor, routeModel } = candidate;
    const attempt = (emptyAttemptsByCandidate.get(key) ?? 0) + 1;
    emptyAttemptsByCandidate.set(key, attempt);
    const exhausted = attempt >= MAX_EMPTY_COMPLETION_ATTEMPTS_PER_CANDIDATE;
    logger.warn(
      `[llm-gateway] empty completion from ${routeModel}@${descriptor.provider} (attempt ${attempt}/${MAX_EMPTY_COMPLETION_ATTEMPTS_PER_CANDIDATE}), ${exhausted ? 'failing over' : 'retrying same candidate'} ${requestId}`,
    );
    step('empty_completion_retry', {
      provider: descriptor.provider,
      routeModel,
      attempt,
      exhausted,
      ...fields,
    });
    if (exhausted) {
      exhaustedCandidates.add(key);
      return;
    }
    await sleep(backoffDelay(attempt, baseDelayMs, maxDelayMs, jitter, rand));
  };

  let upstream: Response | null = null;
  let descriptor: UpstreamDescriptor | null = null;
  let selectedRouteModel = routedModel;
  let tried: string[] = [];
  let modelsTried: string[] = [];
  let attempts = 0;
  let nonStreamBody: unknown;
  let streamProbe: StreamProbeResult | null = null;
  // The real upstream error behind an empty stream, if a candidate returned one
  // (see the error-frame branch below). Surfaced in place of the generic
  // empty-completion 502 when every candidate ends up producing nothing usable.
  let lastErrorFrame: SseErrorFrame | null = null;

  for (;;) {
    const remaining = candidates.filter(
      (candidate) => !exhaustedCandidates.has(candidateKey(candidate)),
    );
    if (remaining.length === 0) {
      step('all_candidates_empty', { ms: lap(), tried, hadErrorFrame: Boolean(lastErrorFrame) });
      // Prefer the real upstream cause (overloaded, request too large, content
      // filter) that a candidate reported over the generic "empty" message that
      // would otherwise bury it.
      const errorCode = lastErrorFrame ? 'upstream_error' : 'empty_completion';
      const message = lastErrorFrame
        ? lastErrorFrame.message
        : 'All upstream candidates returned an empty completion';
      const failedCandidate = [...candidates].reverse().find((candidate) =>
        exhaustedCandidates.has(candidateKey(candidate)),
      );
      const failedDescriptor = failedCandidate?.descriptor;
      emit({
        ...id,
        requestedModel,
        resolvedModel: routedModel,
        streaming,
        status: 502,
        ok: false,
        errorCode,
        errorMessage: message,
        candidatesTried: tried,
        request: capture(payload),
        metadata: routingMetadata(null),
      });
      return json(
        gatewayErrorBody({
          message,
          code: errorCode,
          upstreamCode: lastErrorFrame?.code,
          provider: failedDescriptor?.provider ?? tried.at(-1) ?? '',
          requestedModel,
          resolvedModel: failedDescriptor?.resolvedModel ?? routedModel,
          requestId,
          suggestion: 'Retry the request. If the error continues, switch to another model.',
        }),
        502,
      );
    }

    const result = await runFailover({
      candidates: remaining,
      payload,
      config,
      fetchImpl,
      breakerFor,
      emit,
      logger,
      requestId,
      trace: {
        ...id,
        requestedModel,
        streaming,
        metadata: routingMetadata(null),
      },
      capturedRequest: capture(payload),
      fallbackOn,
    });

    if (result.kind === 'response') {
      step('upstream_failed', { ms: lap(), status: result.response.status });
      return result.response;
    }

    const {
      upstream: candidateUpstream,
      chosen,
      tried: triedThisRound,
      modelsTried: modelsTriedThisRound,
      attempts: attemptsThisRound,
    } = result.value;
    tried = [...tried, ...triedThisRound];
    modelsTried = [...modelsTried, ...modelsTriedThisRound]
      .filter((model, index, all) => all.indexOf(model) === index);
    attempts += attemptsThisRound;
    const { descriptor: chosenDescriptor, routeModel: chosenRouteModel } = chosen;

    if (!streaming) {
      const data = await candidateUpstream.json();
      step('non_stream_body', {
        ms: lap(),
        provider: chosenDescriptor.provider,
        routeModel: chosenRouteModel,
      });
      if (jsonHasContent(data)) {
        upstream = candidateUpstream;
        descriptor = chosenDescriptor;
        selectedRouteModel = chosenRouteModel;
        nonStreamBody = data;
        break;
      }
      await registerEmptyCompletion(chosen, { streaming: false });
      continue;
    }

    if (!candidateUpstream.body) {
      await registerEmptyCompletion(chosen, { streaming: true, reason: 'no_body' });
      continue;
    }

    const probe = await probeStream(candidateUpstream.body);
    if (probe.hasContent) {
      upstream = candidateUpstream;
      descriptor = chosenDescriptor;
      selectedRouteModel = chosenRouteModel;
      streamProbe = probe;
      break;
    }
    // A structured error frame is a definitive failure for THIS candidate, not the
    // transient empty-stop hiccup the same-candidate retry targets — so exclude the
    // candidate at once (no in-place retry) and remember the real error to surface
    // if nothing usable ever arrives. Other candidates, if any, still get a turn.
    if (probe.errorFrame) {
      lastErrorFrame = probe.errorFrame;
      logger.warn(
        `[llm-gateway] upstream error frame from ${chosenDescriptor.provider} ${requestId}: "${probe.errorFrame.message}"${probe.errorFrame.code !== undefined ? ` (code ${probe.errorFrame.code})` : ''}`,
      );
      step('upstream_error_frame', {
        provider: chosenDescriptor.provider,
        routeModel: chosenRouteModel,
        message: probe.errorFrame.message,
        code: probe.errorFrame.code,
      });
      exhaustedCandidates.add(candidateKey(chosen));
      continue;
    }
    if (probe.readError) {
      lastErrorFrame = probe.readError;
      logger.warn(
        `[llm-gateway] upstream stream read failed during probe from ${chosenDescriptor.provider} ${requestId}: "${probe.readError.message}"`,
      );
      step('upstream_stream_error', {
        provider: chosenDescriptor.provider,
        routeModel: chosenRouteModel,
        message: probe.readError.message,
      });
      exhaustedCandidates.add(candidateKey(chosen));
      continue;
    }
    await registerEmptyCompletion(chosen, { streaming: true });
  }

  // Every loop exit above either `return`s (transport failure / all-empty) or
  // `break`s right after assigning both.
  if (!descriptor || !upstream) {
    throw new Error(`unreachable: dispatch loop exited without a chosen upstream (${requestId})`);
  }
  const finalDescriptor: UpstreamDescriptor = descriptor;
  const finalUpstream: Response = upstream;

  step('upstream_ok', {
    ms: lap(),
    provider: finalDescriptor.provider,
    resolvedModel: finalDescriptor.resolvedModel,
    upstreamStatus: finalUpstream.status,
    attempts,
    tried,
    modelsTried,
    selectedRouteModel,
  });

  const traceMetadata = routingMetadata(selectedRouteModel);

  const settle = async (
    usage: ExtractedUsage | null,
    response: unknown,
    streamError?: SseErrorFrame | null,
  ): Promise<void> => {
    const usedModel = (
      usage?.model ??
      finalDescriptor.resolvedModel ??
      requestedModel ??
      'unknown'
    ).toString();
    const counts: TokenCounts = {
      promptTokens: usage?.promptTokens ?? 0,
      completionTokens: usage?.completionTokens ?? 0,
      cachedTokens: usage?.cachedTokens ?? 0,
    };
    const markup = finalDescriptor.billingMode === 'none' ? 0 : finalDescriptor.markup;
    const { upstreamCost, finalCost } = calculateCost(
      usedModel,
      counts,
      markup,
      usage?.upstreamCostHint,
      finalDescriptor.pricing,
    );

    // A billable request that priced to $0 means we have no pricing for the
    // resolved model (stale catalog) — surface it so it can't silently leak.
    if (markup > 0 && upstreamCost === 0 && counts.promptTokens + counts.completionTokens > 0) {
      logger.warn(
        `[llm-gateway] billable request priced at $0 — missing pricing? ${requestId} model=${usedModel} provider=${finalDescriptor.provider}`,
      );
    }

    if (counts.promptTokens + counts.completionTokens > 0) {
      const event: UsageEvent = {
        ...counts,
        accountId: principal.accountId,
        actorUserId: principal.userId,
        projectId: principal.projectId,
        sessionId: principal.sessionId,
        provider: finalDescriptor.provider,
        model: usedModel,
        upstreamCost,
        finalCost,
        billingMode: finalDescriptor.billingMode,
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
      provider: finalDescriptor.provider,
      promptTokens: counts.promptTokens,
      completionTokens: counts.completionTokens,
      cachedTokens: counts.cachedTokens,
      upstreamCost,
      finalCost,
      streaming,
      ...(streamError ? { streamError: streamError.message } : {}),
    });

    // A stream that carried an upstream error frame delivered a failed turn to
    // the caller, whatever the HTTP status said — trace it as such (tokens are
    // still billed above: the upstream consumed them before it died).
    emit({
      ...id,
      requestedModel,
      resolvedModel: usedModel,
      provider: finalDescriptor.provider,
      billingMode: finalDescriptor.billingMode,
      streaming,
      status: 200,
      ok: !streamError,
      ...(streamError
        ? { errorCode: 'upstream_stream_error', errorMessage: streamError.message }
        : {}),
      attempts,
      candidatesTried: tried,
      usage: counts,
      upstreamCost,
      finalCost,
      request: capture(payload),
      response: capture(response),
      metadata: traceMetadata,
    });
  };

  if (!streaming) {
    void settle(extractUsageFromJson(nonStreamBody), nonStreamBody);
    return json(nonStreamBody);
  }

  step('stream_begin');

  // streamProbe is always set on this path — the streaming branch of the
  // dispatch loop only `break`s after assigning it.
  if (!streamProbe) {
    throw new Error(`unreachable: streaming dispatch exited without a probe result (${requestId})`);
  }
  const readable = relayStream({
    primed: { reader: streamProbe.reader, chunks: streamProbe.chunks },
    captureBodies,
    requestId,
    logger,
    settle,
    errorContext: {
      provider: finalDescriptor.provider,
      requestedModel,
      resolvedModel: finalDescriptor.resolvedModel ?? requestedModel,
      requestId,
    },
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

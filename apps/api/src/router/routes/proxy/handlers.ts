import { HTTPException } from 'hono/http-exception';
import { type ProxyServiceConfig } from '../../config/proxy-services';
import { config, KORTIX_MARKUP, PLATFORM_FEE_MARKUP } from '../../../config';
import { requireModelPricing } from '../../config/models';
import {
  accumulateUsageChunk,
  calculateCost,
  extractUsage,
  type UsageAccumulator,
} from '../../services/llm';
import { resolveActorFromRequest, type ActorContext } from '../../../shared/actor-context';
import type { ToolCreditReservation } from './app';
import {
  refundLlmReservation,
  reserveEstimatedLlmCredits,
  settleLlmReservation,
  type LlmCreditReservation,
} from '../../services/llm-reservation';
import {
  matchAllowedRoute,
  tryAuthenticate,
  maybeNormalizeOpenAIResponsesInput,
  buildForwardHeaders,
  getRequestBody,
  reserveToolProxyCredits,
  refundToolReservation,
  injectApiKey,
} from './helpers';

function pricingProvider(service: ProxyServiceConfig, managed: boolean): string {
  if (managed && service.kortixTargetBaseUrl === config.OPENROUTER_API_URL) {
    return 'openrouter';
  }
  return (
    {
      xai: 'x-ai',
      gemini: 'google',
    }[service.name] ?? service.name
  );
}

function usageProvider(service: ProxyServiceConfig): 'openai' | 'anthropic' {
  return service.name === 'anthropic' ? 'anthropic' : 'openai';
}

function usageRoute(service: ProxyServiceConfig, subPath: string): string {
  return `/v1/${service.name}${subPath}`;
}

// === Core Proxy Handler ===
//
// Three authentication/billing modes:
//
// 1. dosco token (kortix_/kortix_sb_ in our DB) in Authorization header
//    → Inject dosco's API key, forward, bill at KORTIX_MARKUP (1.2×).
//
// 2. User's own API key in Authorization + dosco token in X-dosco-Token header
//    → Passthrough (no key injection), bill at PLATFORM_FEE_MARKUP (0.1×).
//
// 3. User's own API key, no dosco token anywhere
//    → Pure passthrough. No billing, no gating (self-hosted / non-dosco user).

export async function handleProxy(c: any, service: ProxyServiceConfig, prefix: string) {
  const fullPath = new URL(c.req.url).pathname;
  const prefixStr = `/${prefix}`;
  // Find the prefix anywhere in the path (handles mount-point prefixing by Hono)
  const prefixIdx = fullPath.indexOf(prefixStr);
  const subPath = prefixIdx !== -1 ? fullPath.slice(prefixIdx + prefixStr.length) || '/' : '/';
  const queryString = new URL(c.req.url).search;
  const method = c.req.method;

  const auth = await tryAuthenticate(c);

  if (auth.isdoscoUser && auth.accountId && !auth.isPassthrough) {
    // Mode 1: dosco-owned key — inject our key, bill at 1.2×
    return handledoscoProxy(c, service, subPath, queryString, method, auth.accountId);
  } else if (auth.isPassthrough && auth.accountId) {
    // Mode 2: User's own key — passthrough, bill at 0.1×
    return handledoscoPassthrough(c, service, subPath, queryString, method, auth.accountId);
  } else {
    // Mode 3: No dosco token — pure passthrough, no billing.
    // When billing is enabled, reject: only kortix_ tokens with billing are accepted.
    if (config.KORTIX_BILLING_INTERNAL_ENABLED) {
      throw new HTTPException(401, {
        message: 'dosco API key required. Get one at https://dosco.live',
      });
    }
    // Self-hosted: allow passthrough for BYOC users with their own API keys.
    return handlePassthrough(c, service, subPath, queryString, method);
  }
}

// === dosco User: match allowed route, inject our key, bill with route-specific pricing ===

async function handledoscoProxy(
  c: any,
  service: ProxyServiceConfig,
  subPath: string,
  queryString: string,
  method: string,
  accountId: string,
) {
  const matchedRoute = matchAllowedRoute(method, subPath, service.allowedRoutes);
  if (!matchedRoute) {
    throw new HTTPException(403, {
      message: `Route not available: ${method} ${subPath}`,
    });
  }

  // Anti-abuse: routes that expose a shared prediction endpoint (where the model is
  // chosen by a `version` in the body, not the URL) must pin the allowed versions.
  if (matchedRoute.allowedBodyVersions && method.toUpperCase() === 'POST') {
    let requestedVersion: unknown;
    try {
      requestedVersion = JSON.parse(await c.req.raw.clone().text())?.version;
    } catch {
      requestedVersion = undefined;
    }
    if (
      typeof requestedVersion !== 'string' ||
      !matchedRoute.allowedBodyVersions.includes(requestedVersion)
    ) {
      throw new HTTPException(403, {
        message: `Model version not allowed for ${service.name}`,
      });
    }
  }

  const kortixKey = service.getdoscoApiKey();
  if (!kortixKey) {
    throw new HTTPException(503, {
      message: `${service.name} not configured`,
    });
  }

  const actor = resolveActorFromRequest(c, { logPrefix: '[PROXY]' });

  // Use alternate target/key injection for dosco-managed if configured (e.g. OpenRouter)
  const baseUrl = service.kortixTargetBaseUrl || service.targetBaseUrl;
  const targetUrl = `${baseUrl}${subPath}${queryString}`;
  const headers = buildForwardHeaders(c);
  // Strip dosco-specific and auth headers — upstream gets injected key only
  headers.delete('x-kortix-token');
  headers.delete('x-api-key');
  headers.delete('authorization');
  let body = await getRequestBody(c, method);

  body = injectApiKey(service, headers, body, /* usedoscoInjection */ true);
  body = maybeNormalizeOpenAIResponsesInput(service, method, subPath, body, headers);
  // Route-specific billing overrides service default.
  const billingToolName = matchedRoute.billingToolName || service.billingToolName;
  let reservation: LlmCreditReservation | null = null;
  let toolReservation: ToolCreditReservation | null = null;
  if (service.isLlm === true) {
    reservation = await reserveEstimatedLlmCredits(
      accountId,
      body,
      KORTIX_MARKUP,
      actor,
      pricingProvider(service, true),
    );
  } else {
    toolReservation = await reserveToolProxyCredits(
      accountId,
      billingToolName,
      actor,
      `Proxy ${service.name}: ${method} ${subPath}`,
    );
  }

  console.log(
    `[PROXY] ${service.name} (kortix:${accountId}) ${method} ${subPath} → ${targetUrl} [bill:${billingToolName}]`,
  );

  let upstream: Response;
  try {
    upstream = await fetch(targetUrl, {
      method,
      headers,
      body,
      // @ts-ignore
      duplex: 'half',
    });
  } catch (error) {
    if (service.isLlm === true) {
      await refundLlmReservation(
        reservation,
        `LLM reservation refund after dispatch error: ${service.name}`,
      ).catch((refundError) =>
        console.error('[PROXY] LLM reservation refund failed:', refundError),
      );
    } else {
      await refundToolReservation(
        toolReservation,
        `Tool reservation refund after dispatch error: ${service.name}`,
      ).catch((refundError) =>
        console.error('[PROXY] Tool reservation refund failed:', refundError),
      );
    }
    throw error;
  }

  // LLM services: bill per-token at KORTIX_MARKUP (1.2×)
  if (service.isLlm === true) {
    if (upstream.ok) {
      return billLlmdoscoProxy(upstream, service, subPath, accountId, actor, reservation);
    }
    // Upstream error — don't bill for failed requests
    console.warn(
      `[PROXY] LLM kortix proxy ${service.name} upstream error ${upstream.status} — no billing`,
    );
    await refundLlmReservation(
      reservation,
      `LLM reservation refund after upstream error: ${service.name}`,
    ).catch((err) => console.error('[PROXY] LLM reservation refund failed:', err));
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    });
  }

  if (!upstream.ok) {
    refundToolReservation(
      toolReservation,
      `Tool reservation refund after upstream error: ${service.name}`,
    ).catch((err) => console.error('[PROXY] Tool reservation refund failed:', err));
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  });
}

// === dosco-managed LLM Billing ===
//
// Handles both response formats based on upstream:
// - OpenAI-compatible: usage.prompt_tokens / completion_tokens
// - Anthropic-native: usage.input_tokens / output_tokens

async function billLlmdoscoProxy(
  upstream: Response,
  service: ProxyServiceConfig,
  subPath: string,
  accountId: string,
  actor: ActorContext | null,
  reservation: LlmCreditReservation | null,
) {
  const contentType = upstream.headers.get('Content-Type') || '';
  const isStreaming = contentType.includes('text/event-stream');

  if (isStreaming) {
    const upstreamBody = upstream.body;
    if (!upstreamBody) {
      await refundLlmReservation(
        reservation,
        `LLM reservation refund after missing stream body: ${service.name}`,
      );
      return new Response(null, { status: 502 });
    }

    const [clientStream, billingStream] = upstreamBody.tee();

    // Fire-and-forget: extract usage from billing stream
    extractUsageFromdoscoProxyStream(
      billingStream,
      service,
      subPath,
      accountId,
      actor,
      reservation,
    );

    return new Response(clientStream, {
      status: upstream.status,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  }

  // Non-streaming: read response, extract usage, bill, return
  let responseBody: any;
  try {
    responseBody = await upstream.json();
  } catch {
    await refundLlmReservation(
      reservation,
      `LLM reservation refund after invalid JSON response: ${service.name}`,
    );
    throw new HTTPException(502, {
      message: `${service.name} returned an invalid JSON response`,
    });
  }
  const provider = usageProvider(service);
  const usage = extractUsage(responseBody, provider);
  let modelId = responseBody?.model || 'unknown';

  if (usage && (usage.promptTokens > 0 || usage.completionTokens > 0)) {
    const modelConfig =
      reservation?.modelConfig ??
      requireModelPricing(modelId, pricingProvider(service, true));
    const cost = calculateCost(
      modelConfig,
      usage.promptTokens,
      usage.completionTokens,
      usage.cachedTokens,
      usage.cacheWriteTokens,
      KORTIX_MARKUP,
      usage.upstreamCost,
    );

    await settleLlmReservation({
      accountId,
      modelId,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      actualCost: cost,
      reservation,
      actor,
      logPrefix: 'LLM kortix billing',
      provider: pricingProvider(service, true),
      route: usageRoute(service, subPath),
      cachedTokens: usage.cachedTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      upstreamCost: usage.upstreamCost,
      upstreamStatus: upstream.status,
    });

    console.log(
      `[PROXY] LLM kortix ${modelId}: ${usage.promptTokens}/${usage.completionTokens} tokens, cost=$${cost.toFixed(6)} (${KORTIX_MARKUP}x)`,
    );
  } else {
    console.warn(`[PROXY] LLM kortix ${service.name}: no usage data in response — billing skipped`);
    await refundLlmReservation(
      reservation,
      `LLM reservation refund after missing usage: ${service.name}`,
    ).catch((err) => console.error('[PROXY] LLM reservation refund failed:', err));
  }

  return new Response(JSON.stringify(responseBody), {
    status: upstream.status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Extract usage from an SSE stream and bill at KORTIX_MARKUP.
 * Handles both OpenAI-compatible and Anthropic-native SSE formats.
 * Runs in background (fire-and-forget).
 */
async function extractUsageFromdoscoProxyStream(
  stream: ReadableStream<Uint8Array>,
  service: ProxyServiceConfig,
  subPath: string,
  accountId: string,
  actor: ActorContext | null,
  reservation: LlmCreditReservation | null,
) {
  let settlementStarted = false;
  try {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let detectedModel = 'unknown';
    const provider = usageProvider(service);
    let usageState: UsageAccumulator | null = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
        try {
          const chunk = JSON.parse(line.slice(6));
          usageState = accumulateUsageChunk(usageState, chunk, provider);
          detectedModel = usageState?.model ?? detectedModel;
        } catch {
          // Not valid JSON — skip
        }
      }
    }

    if (!usageState) {
      console.warn(`[PROXY] LLM kortix stream (${service.name}): no usage data — billing skipped`);
      await refundLlmReservation(
        reservation,
        `LLM reservation refund after missing stream usage: ${service.name}`,
      );
      return;
    }

    const { promptTokens, completionTokens, cachedTokens, cacheWriteTokens, upstreamCost } =
      usageState.usage;
    if (promptTokens > 0 || completionTokens > 0) {
      const modelConfig =
        reservation?.modelConfig ??
        requireModelPricing(detectedModel, pricingProvider(service, true));
      const cost = calculateCost(
        modelConfig,
        promptTokens,
        completionTokens,
        cachedTokens,
        cacheWriteTokens,
        KORTIX_MARKUP,
        upstreamCost,
      );
      settlementStarted = true;
      await settleLlmReservation({
        accountId,
        modelId: detectedModel,
        promptTokens,
        completionTokens,
        actualCost: cost,
        reservation,
        actor,
        logPrefix: 'LLM kortix stream billing',
        provider: pricingProvider(service, true),
        route: usageRoute(service, subPath),
        cachedTokens,
        cacheWriteTokens,
        upstreamCost,
        streaming: true,
        upstreamStatus: 200,
      });
      console.log(
        `[PROXY] LLM kortix stream ${detectedModel}: ${promptTokens}/${completionTokens} tokens, cost=$${cost.toFixed(6)} (${KORTIX_MARKUP}x)`,
      );
    } else {
      console.warn(`[PROXY] LLM kortix stream (${service.name}): zero tokens — billing skipped`);
      await refundLlmReservation(
        reservation,
        `LLM reservation refund after zero stream usage: ${service.name}`,
      );
    }
  } catch (err) {
    console.error(`[PROXY] Error extracting usage from kortix proxy stream:`, err);
    if (!settlementStarted) {
      await refundLlmReservation(
        reservation,
        `LLM reservation refund after stream usage error: ${service.name}`,
      ).catch((refundErr) => console.error('[PROXY] LLM reservation refund failed:', refundErr));
    }
  }
}

// === dosco user with own key: passthrough + bill at platform fee (0.1×) ===

async function handledoscoPassthrough(
  c: any,
  service: ProxyServiceConfig,
  subPath: string,
  queryString: string,
  method: string,
  accountId: string,
) {
  const targetUrl = `${service.targetBaseUrl}${subPath}${queryString}`;
  const headers = buildForwardHeaders(c);
  // Remove X-dosco-Token from forwarded headers — upstream doesn't need it
  headers.delete('x-kortix-token');
  let body = await getRequestBody(c, method);

  body = maybeNormalizeOpenAIResponsesInput(service, method, subPath, body, headers);

  const billingToolName = service.billingToolName;
  const isLlm = service.isLlm === true;
  let reservation: LlmCreditReservation | null = null;
  let toolReservation: ToolCreditReservation | null = null;
  if (isLlm) {
    reservation = await reserveEstimatedLlmCredits(
      accountId,
      body,
      PLATFORM_FEE_MARKUP,
      null,
      pricingProvider(service, false),
    );
  } else {
    toolReservation = await reserveToolProxyCredits(
      accountId,
      billingToolName,
      null,
      `Passthrough ${service.name}: ${method} ${subPath}`,
    );
  }

  console.log(
    `[PROXY] ${service.name} (passthrough:${accountId}) ${method} ${subPath} → ${targetUrl} [bill:${billingToolName}@${PLATFORM_FEE_MARKUP}x]`,
  );

  let upstream: Response;
  try {
    upstream = await fetch(targetUrl, {
      method,
      headers,
      body,
      // @ts-ignore
      duplex: 'half',
    });
  } catch (error) {
    if (isLlm) {
      await refundLlmReservation(
        reservation,
        `LLM reservation refund after dispatch error: ${service.name}`,
      ).catch((refundError) =>
        console.error('[PROXY] LLM reservation refund failed:', refundError),
      );
    } else {
      await refundToolReservation(
        toolReservation,
        `Tool reservation refund after dispatch error: ${service.name}`,
      ).catch((refundError) =>
        console.error('[PROXY] Tool reservation refund failed:', refundError),
      );
    }
    throw error;
  }

  if (isLlm && upstream.ok) {
    // For LLM passthrough: extract token usage and bill at platform fee
    return billLlmPassthrough(upstream, service, subPath, accountId, reservation);
  }

  if (isLlm) {
    // LLM call failed upstream — don't bill for failed requests
    console.warn(
      `[PROXY] LLM passthrough ${service.name} upstream error ${upstream.status} — no billing`,
    );
    await refundLlmReservation(
      reservation,
      `LLM reservation refund after upstream error: ${service.name}`,
    ).catch((err) => console.error('[PROXY] LLM reservation refund failed:', err));
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    });
  }

  if (!upstream.ok) {
    refundToolReservation(
      toolReservation,
      `Tool reservation refund after upstream error: ${service.name}`,
    ).catch((err) => console.error('[PROXY] Tool reservation refund failed:', err));
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  });
}

// === Not dosco user: pure passthrough ===

async function handlePassthrough(
  c: any,
  service: ProxyServiceConfig,
  subPath: string,
  queryString: string,
  method: string,
) {
  const targetUrl = `${service.targetBaseUrl}${subPath}${queryString}`;
  const headers = buildForwardHeaders(c);
  let body = await getRequestBody(c, method);
  body = maybeNormalizeOpenAIResponsesInput(service, method, subPath, body, headers);

  console.log(`[PROXY] ${service.name} (passthrough) ${method} ${subPath}`);

  const upstream = await fetch(targetUrl, {
    method,
    headers,
    body,
    // @ts-ignore
    duplex: 'half',
  });

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  });
}

// === LLM Passthrough Billing ===
//
// For LLM calls using the user's own key routed through our proxy,
// extract token usage from the response and bill at PLATFORM_FEE_MARKUP.

async function billLlmPassthrough(
  upstream: Response,
  service: ProxyServiceConfig,
  subPath: string,
  accountId: string,
  reservation: LlmCreditReservation | null,
) {
  const contentType = upstream.headers.get('Content-Type') || '';
  const isStreaming = contentType.includes('text/event-stream');

  if (isStreaming) {
    const upstreamBody = upstream.body;
    if (!upstreamBody) {
      await refundLlmReservation(
        reservation,
        `LLM reservation refund after missing stream body: ${service.name}`,
      );
      return new Response(null, { status: 502 });
    }

    const [clientStream, billingStream] = upstreamBody.tee();

    // Fire-and-forget: extract usage from billing stream
    extractUsageFromPassthroughStream(billingStream, service, subPath, accountId, reservation);

    return new Response(clientStream, {
      status: upstream.status,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  }

  // Non-streaming: read response, extract usage, bill, return
  let responseBody: any;
  try {
    responseBody = await upstream.json();
  } catch {
    await refundLlmReservation(
      reservation,
      `LLM reservation refund after invalid JSON response: ${service.name}`,
    );
    throw new HTTPException(502, {
      message: `${service.name} returned an invalid JSON response`,
    });
  }
  const provider = usageProvider(service);
  let modelId = 'unknown';
  const usage = extractUsage(responseBody, provider);
  modelId = responseBody?.model || modelId;

  if (usage && (usage.promptTokens > 0 || usage.completionTokens > 0)) {
    const modelConfig =
      reservation?.modelConfig ??
      requireModelPricing(modelId, pricingProvider(service, false));
    const cost = calculateCost(
      modelConfig,
      usage.promptTokens,
      usage.completionTokens,
      usage.cachedTokens,
      usage.cacheWriteTokens,
      PLATFORM_FEE_MARKUP,
      usage.upstreamCost,
    );

    await settleLlmReservation({
      accountId,
      modelId,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      actualCost: cost,
      reservation,
      actor: null,
      logPrefix: 'LLM passthrough billing',
      provider: pricingProvider(service, false),
      route: usageRoute(service, subPath),
      cachedTokens: usage.cachedTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      upstreamCost: usage.upstreamCost,
      upstreamStatus: upstream.status,
    });

    console.log(
      `[PROXY] LLM passthrough ${modelId}: ${usage.promptTokens}/${usage.completionTokens} tokens, cost=$${cost.toFixed(6)} (${PLATFORM_FEE_MARKUP}x)`,
    );
  } else {
    console.warn(`[PROXY] LLM passthrough ${service.name}: no usage data — billing skipped`);
    await refundLlmReservation(
      reservation,
      `LLM reservation refund after missing usage: ${service.name}`,
    ).catch((err) => console.error('[PROXY] LLM reservation refund failed:', err));
  }

  return new Response(JSON.stringify(responseBody), {
    status: upstream.status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Extract usage from an SSE stream and bill at platform fee.
 * Runs in background (fire-and-forget).
 *
 * Handles both SSE formats:
 *   - OpenAI-compatible: usage in final chunk's `usage` field
 *   - Anthropic: input tokens in `message_start`, output in `message_delta`
 */
async function extractUsageFromPassthroughStream(
  stream: ReadableStream<Uint8Array>,
  service: ProxyServiceConfig,
  subPath: string,
  accountId: string,
  reservation: LlmCreditReservation | null,
) {
  let settlementStarted = false;
  try {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let detectedModel = 'unknown';
    const provider = usageProvider(service);
    let usageState: UsageAccumulator | null = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
        try {
          const chunk = JSON.parse(line.slice(6));

          usageState = accumulateUsageChunk(usageState, chunk, provider);
          detectedModel = usageState?.model ?? detectedModel;
        } catch {
          // Not valid JSON — skip
        }
      }
    }

    if (!usageState) {
      console.warn(
        `[PROXY] LLM passthrough stream (${service.name}): no usage data — billing skipped`,
      );
      await refundLlmReservation(
        reservation,
        `LLM reservation refund after missing stream usage: ${service.name}`,
      );
      return;
    }

    const { promptTokens, completionTokens, cachedTokens, cacheWriteTokens, upstreamCost } =
      usageState.usage;
    if (promptTokens > 0 || completionTokens > 0) {
      const modelConfig =
        reservation?.modelConfig ??
        requireModelPricing(detectedModel, pricingProvider(service, false));
      const cost = calculateCost(
        modelConfig,
        promptTokens,
        completionTokens,
        cachedTokens,
        cacheWriteTokens,
        PLATFORM_FEE_MARKUP,
        upstreamCost,
      );
      settlementStarted = true;
      await settleLlmReservation({
        accountId,
        modelId: detectedModel,
        promptTokens,
        completionTokens,
        actualCost: cost,
        reservation,
        actor: null,
        logPrefix: 'LLM passthrough stream billing',
        provider: pricingProvider(service, false),
        route: usageRoute(service, subPath),
        cachedTokens,
        cacheWriteTokens,
        upstreamCost,
        streaming: true,
        upstreamStatus: 200,
      });
      console.log(
        `[PROXY] LLM passthrough stream ${detectedModel}: ${promptTokens}/${completionTokens} tokens, cost=$${cost.toFixed(6)} (${PLATFORM_FEE_MARKUP}x)`,
      );
    } else {
      console.warn(
        `[PROXY] LLM passthrough stream (${service.name}): zero tokens — billing skipped`,
      );
      await refundLlmReservation(
        reservation,
        `LLM reservation refund after zero stream usage: ${service.name}`,
      );
    }
  } catch (err) {
    console.error(`[PROXY] Error extracting usage from passthrough stream:`, err);
    if (!settlementStarted) {
      await refundLlmReservation(
        reservation,
        `LLM reservation refund after stream usage error: ${service.name}`,
      ).catch((refundErr) => console.error('[PROXY] LLM reservation refund failed:', refundErr));
    }
  }
}

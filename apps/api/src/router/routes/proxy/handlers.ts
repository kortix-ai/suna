import { HTTPException } from 'hono/http-exception';
import { type ProxyServiceConfig } from '../../config/proxy-services';
import { config, KORTIX_MARKUP, PLATFORM_FEE_MARKUP } from '../../../config';
import { getModel } from '../../config/models';
import { calculateCost, extractUsage } from '../../services/llm';
import {
  resolveActorFromRequest,
  type ActorContext,
} from '../../../shared/actor-context';
import type { LlmCreditReservation, ToolCreditReservation } from './app';
import {
  matchAllowedRoute,
  tryAuthenticate,
  maybeNormalizeOpenAIResponsesInput,
  buildForwardHeaders,
  getRequestBody,
  reserveEstimatedLlmCredits,
  reserveToolProxyCredits,
  settleLlmReservation,
  refundLlmReservation,
  refundToolReservation,
  injectApiKey,
} from './helpers';

// === Core Proxy Handler ===
//
// Three authentication/billing modes:
//
// 1. Kortix token (kortix_/kortix_sb_ in our DB) in Authorization header
//    → Inject Kortix's API key, forward, bill at KORTIX_MARKUP (1.2×).
//
// 2. User's own API key in Authorization + Kortix token in X-Kortix-Token header
//    → Passthrough (no key injection), bill at PLATFORM_FEE_MARKUP (0.1×).
//
// 3. User's own API key, no Kortix token anywhere
//    → Pure passthrough. No billing, no gating (self-hosted / non-Kortix user).

export async function handleProxy(c: any, service: ProxyServiceConfig, prefix: string) {
  const fullPath = new URL(c.req.url).pathname;
  const prefixStr = `/${prefix}`;
  // Find the prefix anywhere in the path (handles mount-point prefixing by Hono)
  const prefixIdx = fullPath.indexOf(prefixStr);
  const subPath = prefixIdx !== -1
    ? fullPath.slice(prefixIdx + prefixStr.length) || '/'
    : '/';
  const queryString = new URL(c.req.url).search;
  const method = c.req.method;

  const auth = await tryAuthenticate(c);

  if (auth.isKortixUser && auth.accountId && !auth.isPassthrough) {
    // Mode 1: Kortix-owned key — inject our key, bill at 1.2×
    return handleKortixProxy(c, service, subPath, queryString, method, auth.accountId);
  } else if (auth.isPassthrough && auth.accountId) {
    // Mode 2: User's own key — passthrough, bill at 0.1×
    return handleKortixPassthrough(c, service, subPath, queryString, method, auth.accountId);
  } else {
    // Mode 3: No Kortix token — pure passthrough, no billing.
    // When billing is enabled, reject: only kortix_ tokens with billing are accepted.
    if (config.KORTIX_BILLING_INTERNAL_ENABLED) {
      throw new HTTPException(401, {
        message: 'Kortix API key required. Get one at https://kortix.com',
      });
    }
    // Self-hosted: allow passthrough for BYOC users with their own API keys.
    return handlePassthrough(c, service, subPath, queryString, method);
  }
}

// === Kortix User: match allowed route, inject our key, bill with route-specific pricing ===

async function handleKortixProxy(
  c: any,
  service: ProxyServiceConfig,
  subPath: string,
  queryString: string,
  method: string,
  accountId: string
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
    if (typeof requestedVersion !== 'string' || !matchedRoute.allowedBodyVersions.includes(requestedVersion)) {
      throw new HTTPException(403, {
        message: `Model version not allowed for ${service.name}`,
      });
    }
  }

  const kortixKey = service.getKortixApiKey();
  if (!kortixKey) {
    throw new HTTPException(503, {
      message: `${service.name} not configured`,
    });
  }

  const actor = resolveActorFromRequest(c, { logPrefix: '[PROXY]' });

  // Use alternate target/key injection for Kortix-managed if configured (e.g. OpenRouter)
  const baseUrl = service.kortixTargetBaseUrl || service.targetBaseUrl;
  const targetUrl = `${baseUrl}${subPath}${queryString}`;
  const headers = buildForwardHeaders(c);
  // Strip Kortix-specific and auth headers — upstream gets injected key only
  headers.delete('x-kortix-token');
  headers.delete('x-api-key');
  headers.delete('authorization');
  let body = await getRequestBody(c, method);

  body = injectApiKey(service, headers, body, /* useKortixInjection */ true);
  body = maybeNormalizeOpenAIResponsesInput(service, method, subPath, body, headers);
  // Route-specific billing overrides service default.
  const billingToolName = matchedRoute.billingToolName || service.billingToolName;
  let reservation: LlmCreditReservation | null = null;
  let toolReservation: ToolCreditReservation | null = null;
  if (service.isLlm === true) {
    reservation = await reserveEstimatedLlmCredits(accountId, body, KORTIX_MARKUP, actor);
  } else {
    toolReservation = await reserveToolProxyCredits(
      accountId,
      billingToolName,
      actor,
      `Proxy ${service.name}: ${method} ${subPath}`,
    );
  }

  console.log(`[PROXY] ${service.name} (kortix:${accountId}) ${method} ${subPath} → ${targetUrl} [bill:${billingToolName}]`);

  const upstream = await fetch(targetUrl, {
    method,
    headers,
    body,
    // @ts-ignore
    duplex: 'half',
  });

  // LLM services: bill per-token at KORTIX_MARKUP (1.2×)
  if (service.isLlm === true) {
    if (upstream.ok) {
      return billLlmKortixProxy(upstream, service, subPath, accountId, actor, reservation);
    }
    // Upstream error — don't bill for failed requests
    console.warn(`[PROXY] LLM kortix proxy ${service.name} upstream error ${upstream.status} — no billing`);
    refundLlmReservation(reservation, `LLM reservation refund after upstream error: ${service.name}`).catch(
      (err) => console.error('[PROXY] LLM reservation refund failed:', err),
    );
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    });
  }

  if (!upstream.ok) {
    refundToolReservation(toolReservation, `Tool reservation refund after upstream error: ${service.name}`).catch(
      (err) => console.error('[PROXY] Tool reservation refund failed:', err),
    );
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  });
}

// === Kortix-managed LLM Billing ===
//
// Handles both response formats based on upstream:
// - OpenAI-compatible: usage.prompt_tokens / completion_tokens
// - Anthropic-native: usage.input_tokens / output_tokens

async function billLlmKortixProxy(
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
      return new Response(null, { status: 502 });
    }

    const [clientStream, billingStream] = upstreamBody.tee();

    // Fire-and-forget: extract usage from billing stream
    extractUsageFromKortixProxyStream(billingStream, service, subPath, accountId, actor, reservation);

    return new Response(clientStream, {
      status: upstream.status,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  }

  // Non-streaming: read response, extract usage, bill, return
  const responseBody = await upstream.json();
  const isAnthropic = service.name === 'anthropic';

  let promptTokens = 0;
  let completionTokens = 0;
  let cachedTokens = 0;
  let cacheWriteTokens = 0;
  let modelId = responseBody?.model || 'unknown';

  if (isAnthropic && responseBody?.usage) {
    promptTokens = responseBody.usage.input_tokens ?? 0;
    completionTokens = responseBody.usage.output_tokens ?? 0;
  } else {
    const usage = extractUsage(responseBody);
    if (usage) {
      promptTokens = usage.promptTokens;
      completionTokens = usage.completionTokens;
      cachedTokens = usage.cachedTokens;
      cacheWriteTokens = usage.cacheWriteTokens;
    }
  }

  if (promptTokens > 0 || completionTokens > 0) {
    const modelConfig = getModel(modelId);
    const cost = calculateCost(
      modelConfig,
      promptTokens,
      completionTokens,
      cachedTokens,
      cacheWriteTokens,
      KORTIX_MARKUP,
    );

    settleLlmReservation({
      accountId,
      modelId,
      promptTokens,
      completionTokens,
      actualCost: cost,
      reservation,
      actor,
      logPrefix: 'LLM kortix billing',
    }).catch((err) => console.error(`[PROXY] LLM kortix billing error: ${err}`));

    console.log(`[PROXY] LLM kortix ${modelId}: ${promptTokens}/${completionTokens} tokens, cost=$${cost.toFixed(6)} (${KORTIX_MARKUP}x)`);
  } else {
    console.warn(`[PROXY] LLM kortix ${service.name}: no usage data in response — billing skipped`);
    refundLlmReservation(reservation, `LLM reservation refund after missing usage: ${service.name}`).catch(
      (err) => console.error('[PROXY] LLM reservation refund failed:', err),
    );
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
async function extractUsageFromKortixProxyStream(
  stream: ReadableStream<Uint8Array>,
  service: ProxyServiceConfig,
  subPath: string,
  accountId: string,
  actor: ActorContext | null,
  reservation: LlmCreditReservation | null,
) {
  try {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let detectedModel = 'unknown';
    const isAnthropic = service.name === 'anthropic';
    let lastUsage: { promptTokens: number; completionTokens: number; cachedTokens: number; cacheWriteTokens: number } | null = null;
    let anthropicInputTokens = 0;
    let anthropicOutputTokens = 0;

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
          if (isAnthropic) {
            if (chunk.type === 'message_start' && chunk.message) {
              detectedModel = chunk.message.model || detectedModel;
              anthropicInputTokens = chunk.message.usage?.input_tokens ?? 0;
            }
            if (chunk.type === 'message_delta' && chunk.usage) {
              anthropicOutputTokens = chunk.usage.output_tokens ?? 0;
            }
          } else {
            if (chunk.model) detectedModel = chunk.model;
            if (chunk.usage) {
              const details = chunk.usage.prompt_tokens_details;
              lastUsage = {
                promptTokens: chunk.usage.prompt_tokens ?? 0,
                completionTokens: chunk.usage.completion_tokens ?? 0,
                cachedTokens: details?.cached_tokens ?? 0,
                cacheWriteTokens: details?.cache_write_tokens ?? 0,
              };
            }
          }
        } catch {
          // Not valid JSON — skip
        }
      }
    }

    if (isAnthropic) {
      if (!(anthropicInputTokens > 0 || anthropicOutputTokens > 0)) {
        console.warn(`[PROXY] LLM kortix stream (${service.name}): zero tokens — billing skipped`);
        await refundLlmReservation(reservation, `LLM reservation refund after zero stream usage: ${service.name}`);
        return;
      }
      const modelConfig = getModel(detectedModel);
      const cost = calculateCost(modelConfig, anthropicInputTokens, anthropicOutputTokens, 0, 0, KORTIX_MARKUP);
      await settleLlmReservation({
        accountId,
        modelId: detectedModel,
        promptTokens: anthropicInputTokens,
        completionTokens: anthropicOutputTokens,
        actualCost: cost,
        reservation,
        actor,
        logPrefix: 'LLM kortix stream billing',
      });
      console.log(`[PROXY] LLM kortix stream ${detectedModel}: ${anthropicInputTokens}/${anthropicOutputTokens} tokens, cost=$${cost.toFixed(6)} (${KORTIX_MARKUP}x)`);
      return;
    }

    if (!lastUsage) {
      console.warn(`[PROXY] LLM kortix stream (${service.name}): no usage data — billing skipped`);
      await refundLlmReservation(reservation, `LLM reservation refund after missing stream usage: ${service.name}`);
      return;
    }

    const { promptTokens, completionTokens, cachedTokens, cacheWriteTokens } = lastUsage;
    if (promptTokens > 0 || completionTokens > 0) {
      const modelConfig = getModel(detectedModel);
      const cost = calculateCost(modelConfig, promptTokens, completionTokens, cachedTokens, cacheWriteTokens, KORTIX_MARKUP);
      await settleLlmReservation({
        accountId,
        modelId: detectedModel,
        promptTokens,
        completionTokens,
        actualCost: cost,
        reservation,
        actor,
        logPrefix: 'LLM kortix stream billing',
      });
      console.log(`[PROXY] LLM kortix stream ${detectedModel}: ${promptTokens}/${completionTokens} tokens, cost=$${cost.toFixed(6)} (${KORTIX_MARKUP}x)`);
    } else {
      console.warn(`[PROXY] LLM kortix stream (${service.name}): zero tokens — billing skipped`);
      await refundLlmReservation(reservation, `LLM reservation refund after zero stream usage: ${service.name}`);
    }
  } catch (err) {
    console.error(`[PROXY] Error extracting usage from kortix proxy stream:`, err);
    await refundLlmReservation(reservation, `LLM reservation refund after stream usage error: ${service.name}`).catch(
      (refundErr) => console.error('[PROXY] LLM reservation refund failed:', refundErr),
    );
  }
}

// === Kortix user with own key: passthrough + bill at platform fee (0.1×) ===

async function handleKortixPassthrough(
  c: any,
  service: ProxyServiceConfig,
  subPath: string,
  queryString: string,
  method: string,
  accountId: string,
) {
  const targetUrl = `${service.targetBaseUrl}${subPath}${queryString}`;
  const headers = buildForwardHeaders(c);
  // Remove X-Kortix-Token from forwarded headers — upstream doesn't need it
  headers.delete('x-kortix-token');
  let body = await getRequestBody(c, method);

  body = maybeNormalizeOpenAIResponsesInput(service, method, subPath, body, headers);

  const billingToolName = service.billingToolName;
  const isLlm = service.isLlm === true;
  let reservation: LlmCreditReservation | null = null;
  let toolReservation: ToolCreditReservation | null = null;
  if (isLlm) {
    reservation = await reserveEstimatedLlmCredits(accountId, body, PLATFORM_FEE_MARKUP, null);
  } else {
    toolReservation = await reserveToolProxyCredits(
      accountId,
      billingToolName,
      null,
      `Passthrough ${service.name}: ${method} ${subPath}`,
    );
  }

  console.log(`[PROXY] ${service.name} (passthrough:${accountId}) ${method} ${subPath} → ${targetUrl} [bill:${billingToolName}@${PLATFORM_FEE_MARKUP}x]`);

  const upstream = await fetch(targetUrl, {
    method,
    headers,
    body,
    // @ts-ignore
    duplex: 'half',
  });

  if (isLlm && upstream.ok) {
    // For LLM passthrough: extract token usage and bill at platform fee
    return billLlmPassthrough(upstream, service, subPath, accountId, reservation);
  }

  if (isLlm) {
    // LLM call failed upstream — don't bill for failed requests
    console.warn(`[PROXY] LLM passthrough ${service.name} upstream error ${upstream.status} — no billing`);
    refundLlmReservation(reservation, `LLM reservation refund after upstream error: ${service.name}`).catch(
      (err) => console.error('[PROXY] LLM reservation refund failed:', err),
    );
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    });
  }

  if (!upstream.ok) {
    refundToolReservation(toolReservation, `Tool reservation refund after upstream error: ${service.name}`).catch(
      (err) => console.error('[PROXY] Tool reservation refund failed:', err),
    );
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  });
}

// === Not Kortix user: pure passthrough ===

async function handlePassthrough(
  c: any,
  service: ProxyServiceConfig,
  subPath: string,
  queryString: string,
  method: string
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
        'Connection': 'keep-alive',
      },
    });
  }

  // Non-streaming: read response, extract usage, bill, return
  const responseBody = await upstream.json();
  const isAnthropic = service.name === 'anthropic';

  // Extract usage — handle both OpenAI and Anthropic response formats
  let promptTokens = 0;
  let completionTokens = 0;
  let cachedTokens = 0;
  let cacheWriteTokens = 0;
  let modelId = 'unknown';

  if (isAnthropic && responseBody?.usage) {
    // Anthropic: { usage: { input_tokens, output_tokens }, model }
    promptTokens = responseBody.usage.input_tokens ?? 0;
    completionTokens = responseBody.usage.output_tokens ?? 0;
    modelId = responseBody.model || modelId;
  } else {
    // OpenAI-compatible: { usage: { prompt_tokens, completion_tokens }, model }
    const usage = extractUsage(responseBody);
    if (usage) {
      promptTokens = usage.promptTokens;
      completionTokens = usage.completionTokens;
      cachedTokens = usage.cachedTokens;
      cacheWriteTokens = usage.cacheWriteTokens;
    }
    modelId = responseBody?.model || modelId;
  }

  if (promptTokens > 0 || completionTokens > 0) {
    const modelConfig = getModel(modelId);
    const cost = calculateCost(modelConfig, promptTokens, completionTokens, cachedTokens, cacheWriteTokens, PLATFORM_FEE_MARKUP);

    settleLlmReservation({
      accountId,
      modelId,
      promptTokens,
      completionTokens,
      actualCost: cost,
      reservation,
      actor: null,
      logPrefix: 'LLM passthrough billing',
    }).catch((err) => console.error(`[PROXY] LLM passthrough billing error: ${err}`));

    console.log(`[PROXY] LLM passthrough ${modelId}: ${promptTokens}/${completionTokens} tokens, cost=$${cost.toFixed(6)} (${PLATFORM_FEE_MARKUP}x)`);
  } else {
    console.warn(`[PROXY] LLM passthrough ${service.name}: no usage data — billing skipped`);
    refundLlmReservation(reservation, `LLM reservation refund after missing usage: ${service.name}`).catch(
      (err) => console.error('[PROXY] LLM reservation refund failed:', err),
    );
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
  try {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let detectedModel = 'unknown';
    const isAnthropic = service.name === 'anthropic';

    // OpenAI-compatible tracking
    let lastUsage: { promptTokens: number; completionTokens: number } | null = null;

    // Anthropic-specific tracking
    let anthropicInputTokens = 0;
    let anthropicOutputTokens = 0;

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

          if (isAnthropic) {
            // Anthropic SSE: message_start → input tokens, message_delta → output tokens
            if (chunk.type === 'message_start' && chunk.message) {
              detectedModel = chunk.message.model || detectedModel;
              anthropicInputTokens = chunk.message.usage?.input_tokens ?? 0;
            }
            if (chunk.type === 'message_delta' && chunk.usage) {
              anthropicOutputTokens = chunk.usage.output_tokens ?? 0;
            }
          } else {
            // OpenAI-compatible SSE
            if (chunk.model) detectedModel = chunk.model;
            if (chunk.usage) {
              lastUsage = {
                promptTokens: chunk.usage.prompt_tokens ?? 0,
                completionTokens: chunk.usage.completion_tokens ?? 0,
              };
            }
          }
        } catch {
          // Not valid JSON — skip
        }
      }
    }

    let promptTokens: number;
    let completionTokens: number;

    if (isAnthropic) {
      promptTokens = anthropicInputTokens;
      completionTokens = anthropicOutputTokens;
    } else if (lastUsage) {
      promptTokens = lastUsage.promptTokens;
      completionTokens = lastUsage.completionTokens;
    } else {
      console.warn(`[PROXY] LLM passthrough stream (${service.name}): no usage data — billing skipped`);
      await refundLlmReservation(reservation, `LLM reservation refund after missing stream usage: ${service.name}`);
      return;
    }

    if (promptTokens > 0 || completionTokens > 0) {
      const modelConfig = getModel(detectedModel);
      const cost = calculateCost(modelConfig, promptTokens, completionTokens, 0, 0, PLATFORM_FEE_MARKUP);
      await settleLlmReservation({
        accountId,
        modelId: detectedModel,
        promptTokens,
        completionTokens,
        actualCost: cost,
        reservation,
        actor: null,
        logPrefix: 'LLM passthrough stream billing',
      });
      console.log(`[PROXY] LLM passthrough stream ${detectedModel}: ${promptTokens}/${completionTokens} tokens, cost=$${cost.toFixed(6)} (${PLATFORM_FEE_MARKUP}x)`);
    } else {
      console.warn(`[PROXY] LLM passthrough stream (${service.name}): zero tokens — billing skipped`);
      await refundLlmReservation(reservation, `LLM reservation refund after zero stream usage: ${service.name}`);
    }
  } catch (err) {
    console.error(`[PROXY] Error extracting usage from passthrough stream:`, err);
    await refundLlmReservation(reservation, `LLM reservation refund after stream usage error: ${service.name}`).catch(
      (refundErr) => console.error('[PROXY] LLM reservation refund failed:', refundErr),
    );
  }
}

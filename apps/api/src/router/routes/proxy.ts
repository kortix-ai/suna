import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  getProxyServices,
  matchAllowedRoute,
  type ProxyServiceConfig,
} from '../config/proxy-services';
import { validateSecretKey } from '../../repositories/api-keys';
import { isKortixToken } from '../../shared/crypto';
import { config, KORTIX_MARKUP, PLATFORM_FEE_MARKUP } from '../../config';
import { checkCredits, deductToolCredits, deductLLMCredits } from '../services/billing';
import { getModel, type ModelConfig } from '../config/models';
import { calculateCost, extractUsage } from '../services/llm';

const proxy = new Hono();

/**
 * Strip hop-by-hop and transport-encoding headers that become invalid after
 * Bun's fetch() auto-decompresses the upstream response body.
 * Without this, clients see Content-Encoding: gzip on an already-decompressed
 * body and get ZlibError when they try to decompress again.
 */
function stripTransportHeaders(headers: Headers): Headers {
  const cleaned = new Headers(headers);
  cleaned.delete('content-encoding');
  cleaned.delete('content-length'); // length is wrong after decompression
  cleaned.delete('transfer-encoding');
  return cleaned;
}

const services = getProxyServices();

for (const [prefix, serviceConfig] of Object.entries(services)) {
  proxy.all(`/${prefix}/*`, (c) => handleProxy(c, serviceConfig, prefix));
  proxy.all(`/${prefix}`, (c) => handleProxy(c, serviceConfig, prefix));
}

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

async function handleProxy(c: any, service: ProxyServiceConfig, prefix: string) {
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
    // In cloud mode, reject: only kortix_ tokens with billing are accepted.
    if (config.isCloud()) {
      throw new HTTPException(401, {
        message: 'Kortix API key required. Get one at https://kortix.com',
      });
    }
    // Local/self-hosted: allow passthrough for BYOC users with their own API keys.
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

  const creditCheck = await checkCredits(accountId, 0.01, { skipDevCheck: true });
  if (!creditCheck.hasCredits) {
    throw new HTTPException(402, { message: creditCheck.message });
  }

  const kortixKey = service.getKortixApiKey();
  if (!kortixKey) {
    throw new HTTPException(503, {
      message: `${service.name} not configured`,
    });
  }

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

  // Route-specific billing overrides service default
  const billingToolName = matchedRoute.billingToolName || service.billingToolName;

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
      return billLlmKortixProxy(upstream, service, subPath, accountId);
    }
    // Upstream error — don't bill for failed requests
    console.warn(`[PROXY] LLM kortix proxy ${service.name} upstream error ${upstream.status} — no billing`);
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: stripTransportHeaders(upstream.headers),
    });
  }

  // Non-LLM services: fixed per-call billing (fire-and-forget)
  deductToolCredits(
    accountId,
    billingToolName,
    0,
    `Proxy ${service.name}: ${method} ${subPath}`,
    undefined,
    { skipDevCheck: true },
  ).catch((err) => console.error(`[PROXY] Billing error: ${err}`));

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: stripTransportHeaders(upstream.headers),
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
    extractUsageFromKortixProxyStream(billingStream, service, subPath, accountId);

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

    deductLLMCredits(
      accountId,
      modelId,
      promptTokens,
      completionTokens,
      cost,
    ).catch((err) => console.error(`[PROXY] LLM kortix billing error: ${err}`));

    console.log(`[PROXY] LLM kortix ${modelId}: ${promptTokens}/${completionTokens} tokens, cost=$${cost.toFixed(6)} (${KORTIX_MARKUP}x)`);
  } else {
    console.warn(`[PROXY] LLM kortix ${service.name}: no usage data in response — billing skipped`);
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
        return;
      }
      const modelConfig = getModel(detectedModel);
      const cost = calculateCost(modelConfig, anthropicInputTokens, anthropicOutputTokens, 0, 0, KORTIX_MARKUP);
      await deductLLMCredits(accountId, detectedModel, anthropicInputTokens, anthropicOutputTokens, cost);
      console.log(`[PROXY] LLM kortix stream ${detectedModel}: ${anthropicInputTokens}/${anthropicOutputTokens} tokens, cost=$${cost.toFixed(6)} (${KORTIX_MARKUP}x)`);
      return;
    }

    if (!lastUsage) {
      console.warn(`[PROXY] LLM kortix stream (${service.name}): no usage data — billing skipped`);
      return;
    }

    const { promptTokens, completionTokens, cachedTokens, cacheWriteTokens } = lastUsage;
    if (promptTokens > 0 || completionTokens > 0) {
      const modelConfig = getModel(detectedModel);
      const cost = calculateCost(modelConfig, promptTokens, completionTokens, cachedTokens, cacheWriteTokens, KORTIX_MARKUP);
      await deductLLMCredits(accountId, detectedModel, promptTokens, completionTokens, cost);
      console.log(`[PROXY] LLM kortix stream ${detectedModel}: ${promptTokens}/${completionTokens} tokens, cost=$${cost.toFixed(6)} (${KORTIX_MARKUP}x)`);
    } else {
      console.warn(`[PROXY] LLM kortix stream (${service.name}): zero tokens — billing skipped`);
    }
  } catch (err) {
    console.error(`[PROXY] Error extracting usage from kortix proxy stream:`, err);
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
  const creditCheck = await checkCredits(accountId, 0.01, { skipDevCheck: true });
  if (!creditCheck.hasCredits) {
    throw new HTTPException(402, { message: creditCheck.message });
  }

  const targetUrl = `${service.targetBaseUrl}${subPath}${queryString}`;
  const headers = buildForwardHeaders(c);
  // Remove X-Kortix-Token from forwarded headers — upstream doesn't need it
  headers.delete('x-kortix-token');
  let body = await getRequestBody(c, method);

  body = maybeNormalizeOpenAIResponsesInput(service, method, subPath, body, headers);

  const billingToolName = service.billingToolName;
  const isLlm = service.isLlm === true;

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
    return billLlmPassthrough(upstream, service, subPath, accountId);
  }

  if (isLlm) {
    // LLM call failed upstream — don't bill for failed requests
    console.warn(`[PROXY] LLM passthrough ${service.name} upstream error ${upstream.status} — no billing`);
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: stripTransportHeaders(upstream.headers),
    });
  }

  // For tool passthrough: fixed per-call billing at platform fee
  deductToolCredits(
    accountId,
    billingToolName,
    0,
    `Passthrough ${service.name}: ${method} ${subPath}`,
    undefined,
    { skipDevCheck: true },
  ).catch((err) => console.error(`[PROXY] Passthrough billing error: ${err}`));

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: stripTransportHeaders(upstream.headers),
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
    headers: stripTransportHeaders(upstream.headers),
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
    extractUsageFromPassthroughStream(billingStream, service, subPath, accountId);

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

    deductLLMCredits(
      accountId,
      modelId,
      promptTokens,
      completionTokens,
      cost,
    ).catch((err) => console.error(`[PROXY] LLM passthrough billing error: ${err}`));

    console.log(`[PROXY] LLM passthrough ${modelId}: ${promptTokens}/${completionTokens} tokens, cost=$${cost.toFixed(6)} (${PLATFORM_FEE_MARKUP}x)`);
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
      return;
    }

    if (promptTokens > 0 || completionTokens > 0) {
      const modelConfig = getModel(detectedModel);
      const cost = calculateCost(modelConfig, promptTokens, completionTokens, 0, 0, PLATFORM_FEE_MARKUP);
      await deductLLMCredits(
        accountId,
        detectedModel,
        promptTokens,
        completionTokens,
        cost,
      );
      console.log(`[PROXY] LLM passthrough stream ${detectedModel}: ${promptTokens}/${completionTokens} tokens, cost=$${cost.toFixed(6)} (${PLATFORM_FEE_MARKUP}x)`);
    } else {
      console.warn(`[PROXY] LLM passthrough stream (${service.name}): zero tokens — billing skipped`);
    }
  } catch (err) {
    console.error(`[PROXY] Error extracting usage from passthrough stream:`, err);
  }
}

// === Helpers ===

interface AuthResult {
  isKortixUser: boolean;
  accountId?: string;
  /** True when the user's own API key is in Authorization (passthrough) but we identified the account via X-Kortix-Token. */
  isPassthrough?: boolean;
}

async function tryAuthenticate(c: any): Promise<AuthResult> {
  const authHeader = c.req.header('Authorization');
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;

  // --- Mode 1: Kortix token directly in Authorization header ---
  // The user sent kortix_ or kortix_sb_ as the Bearer token — full Kortix-managed flow.
  // If it looks like a Kortix token but fails validation → hard reject.

  if (bearerToken && isKortixToken(bearerToken) && config.DATABASE_URL) {
    try {
      const result = await validateSecretKey(bearerToken);
      if (result.isValid && result.accountId) {
        return { isKortixUser: true, accountId: result.accountId };
      }
    } catch {
      // Fall through to reject below
    }
    // Looks like a Kortix token but didn't validate — reject.
    // Never allow an invalid Kortix token to fall through to free passthrough.
    throw new HTTPException(401, { message: 'Invalid Kortix token' });
  }

  // --- Mode 1a: Kortix token in Authorization: Token <token> (Replicate SDK) ---
  // The Replicate SDK uses "Token " prefix instead of "Bearer ".
  const tokenPrefixed = authHeader?.startsWith('Token ') ? authHeader.slice(6) : undefined;
  if (tokenPrefixed && isKortixToken(tokenPrefixed) && config.DATABASE_URL) {
    try {
      const result = await validateSecretKey(tokenPrefixed);
      if (result.isValid && result.accountId) {
        return { isKortixUser: true, accountId: result.accountId };
      }
    } catch {
      // Fall through to reject below
    }
    throw new HTTPException(401, { message: 'Invalid Kortix token' });
  }

  // --- Mode 1b: Kortix token in x-api-key header (Anthropic SDK) ---
  // The Anthropic SDK sends the API key via x-api-key instead of Authorization.
  // If the value is a Kortix token, treat it as Mode 1 (Kortix-managed).
  const xApiKey = c.req.header('x-api-key');
  if (xApiKey && isKortixToken(xApiKey) && config.DATABASE_URL) {
    try {
      const result = await validateSecretKey(xApiKey);
      if (result.isValid && result.accountId) {
        return { isKortixUser: true, accountId: result.accountId };
      }
    } catch {
      // Fall through to reject below
    }
    throw new HTTPException(401, { message: 'Invalid Kortix token in x-api-key' });
  }

  // --- Mode 1c: Kortix token in JSON body field (Tavily SDK) ---
  // The Tavily SDK sends the API key in the JSON body as "api_key" instead of a header.
  // Check the body for a Kortix token so sandbox tools can auth through the proxy.
  if (config.DATABASE_URL && c.req.method === 'POST') {
    try {
      const cloned = c.req.raw.clone();
      const bodyText = await cloned.text();
      if (bodyText && bodyText.includes('kortix_')) {
        const json = JSON.parse(bodyText);
        const bodyApiKey = json?.api_key;
        if (bodyApiKey && isKortixToken(bodyApiKey)) {
          const result = await validateSecretKey(bodyApiKey);
          if (result.isValid && result.accountId) {
            return { isKortixUser: true, accountId: result.accountId };
          }
          throw new HTTPException(401, { message: 'Invalid Kortix token in request body' });
        }
      }
    } catch (e) {
      if (e instanceof HTTPException) throw e;
      // Body wasn't JSON or didn't contain api_key — continue
    }
  }

  // --- Mode 2: User's own key + Kortix token in X-Kortix-Token ---
  // The user's own API key is in Authorization (Bearer) or a provider-specific
  // header (e.g. Anthropic's x-api-key). The Kortix token rides in
  // X-Kortix-Token so we can identify the account for platform-fee billing.
  // If X-Kortix-Token looks like a Kortix token but fails → hard reject.

  if (config.DATABASE_URL) {
    const kortixTokenHeader = c.req.header('X-Kortix-Token');
    if (kortixTokenHeader && isKortixToken(kortixTokenHeader)) {
      try {
        const result = await validateSecretKey(kortixTokenHeader);
        if (result.isValid && result.accountId) {
          return { isKortixUser: true, accountId: result.accountId, isPassthrough: true };
        }
      } catch {
        // Fall through to reject below
      }
      throw new HTTPException(401, { message: 'Invalid X-Kortix-Token' });
    }
  }

  // --- Mode 3: No Kortix token anywhere — pure passthrough, no billing ---
  return { isKortixUser: false };
}

/**
 * OpenAI Responses API is strict about input item shapes. Some clients send
 * mixed/legacy message arrays (including reasoning parts) that can be accepted
 * by chat/completions but rejected by /responses with 400 invalid_prompt.
 *
 * For /openai/responses requests we normalize input into a conservative shape:
 *   [{ role: 'user'|'system'|'developer', content: '<text>' }, ...]
 *
 * This keeps conversations working instead of hard failing on schema mismatch.
 */
function maybeNormalizeOpenAIResponsesInput(
  service: ProxyServiceConfig,
  method: string,
  subPath: string,
  body: ArrayBuffer | string | undefined,
  headers: Headers,
): ArrayBuffer | string | undefined {
  if (service.name !== 'openai') return body;
  if (method !== 'POST') return body;
  if (!body) return body;
  if (subPath.split('?')[0] !== '/responses') return body;

  try {
    const text = typeof body === 'string' ? body : new TextDecoder().decode(body);
    const parsed = JSON.parse(text) as Record<string, any>;
    if (!Array.isArray(parsed.input)) return body;

    const normalized: Array<{ role: 'user' | 'system' | 'developer'; content: string }> = [];

    for (const item of parsed.input) {
      if (typeof item === 'string') {
        const t = item.trim();
        if (t) normalized.push({ role: 'user', content: t });
        continue;
      }

      if (Array.isArray(item)) {
        const t = extractText(item).trim();
        if (t) normalized.push({ role: 'user', content: t });
        continue;
      }

      if (item && typeof item === 'object') {
        const roleRaw = typeof item.role === 'string' ? item.role : 'user';
        const role: 'user' | 'system' | 'developer' =
          roleRaw === 'system' || roleRaw === 'developer' ? roleRaw : 'user';

        const contentValue = item.content ?? item.text ?? item.output ?? item.input;
        const t = extractText(contentValue).trim();
        if (t) normalized.push({ role, content: t });
      }
    }

    if (normalized.length === 0) {
      normalized.push({ role: 'user', content: 'Continue.' });
    }

    parsed.input = normalized;
    const newBody = JSON.stringify(parsed);
    headers.set('Content-Length', new TextEncoder().encode(newBody).length.toString());
    return newBody;
  } catch {
    return body;
  }
}

function extractText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  if (Array.isArray(value)) {
    return value
      .map((v) => extractText(v))
      .filter(Boolean)
      .join('\n');
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    // Common OpenAI/SDK content shapes.
    if (typeof obj.text === 'string') return obj.text;
    if (typeof obj.output_text === 'string') return obj.output_text;
    if (typeof obj.content === 'string') return obj.content;
    if (obj.content) return extractText(obj.content);
    if (obj.output) return extractText(obj.output);
    if (obj.input) return extractText(obj.input);
  }

  return '';
}

function buildForwardHeaders(c: any): Headers {
  const headers = new Headers();
  for (const [key, value] of c.req.raw.headers.entries()) {
    if (key.toLowerCase() !== 'host') {
      headers.set(key, value);
    }
  }
  return headers;
}

async function getRequestBody(c: any, method: string): Promise<ArrayBuffer | string | undefined> {
  if (method === 'GET' || method === 'HEAD') return undefined;
  return await c.req.raw.clone().arrayBuffer();
}

function injectApiKey(
  service: ProxyServiceConfig,
  headers: Headers,
  body: ArrayBuffer | string | undefined,
  useKortixInjection = false,
): ArrayBuffer | string | undefined {
  const injection = (useKortixInjection && service.kortixKeyInjection) || service.keyInjection;
  const key = service.getKortixApiKey();

  switch (injection.type) {
    case 'header': {
      const value = injection.prefix ? `${injection.prefix}${key}` : key;
      headers.set(injection.headerName, value);
      return body;
    }

    case 'json_body_field': {
      if (!body) return body;
      try {
        const text = typeof body === 'string'
          ? body
          : new TextDecoder().decode(body);
        const json = JSON.parse(text);
        json[injection.field] = key;
        const newBody = JSON.stringify(json);
        headers.set('Content-Length', new TextEncoder().encode(newBody).length.toString());
        return newBody;
      } catch {
        console.warn(`[PROXY] Could not inject API key into body for ${service.name}`);
        return body;
      }
    }

    default:
      return body;
  }
}

export { proxy };

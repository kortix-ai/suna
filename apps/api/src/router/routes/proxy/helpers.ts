import { HTTPException } from 'hono/http-exception';
import {
  matchAllowedRoute,
  type ProxyServiceConfig,
} from '../../config/proxy-services';
import { validateSecretKey } from '../../../repositories/api-keys';
import { isKortixToken } from '../../../shared/crypto';
import { config, getToolCost } from '../../../config';
import { deductToolCredits, deductLLMCredits } from '../../services/billing';
import { getModel } from '../../config/models';
import { calculateCost } from '../../services/llm';
import { grantCredits } from '../../../billing/services/credits';
import { dollarsToCents, refundActorSpend, reserveActorSpend } from '../../services/member-spend';
import {
  type ActorContext,
} from '../../../shared/actor-context';
import { getTraceHeaders } from '../../../lib/request-context';
import type { LlmCreditReservation, ToolCreditReservation, AuthResult } from './app';

// Re-export matchAllowedRoute for handlers (kept here so handlers import from one place)
export { matchAllowedRoute };

export async function tryAuthenticate(c: any): Promise<AuthResult> {
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
export function maybeNormalizeOpenAIResponsesInput(
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

export function extractText(value: unknown): string {
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

export function buildForwardHeaders(c: any): Headers {
  const headers = new Headers();
  for (const [key, value] of c.req.raw.headers.entries()) {
    const lower = key.toLowerCase();
    if (lower !== 'host' && lower !== 'traceparent' && lower !== 'x-request-id') {
      headers.set(key, value);
    }
  }
  for (const [key, value] of Object.entries(getTraceHeaders())) {
    headers.set(key, value);
  }
  return headers;
}

export async function getRequestBody(c: any, method: string): Promise<ArrayBuffer | string | undefined> {
  if (method === 'GET' || method === 'HEAD') return undefined;
  return await c.req.raw.clone().arrayBuffer();
}

export async function reserveEstimatedLlmCredits(
  accountId: string,
  body: ArrayBuffer | string | undefined,
  markup: number,
  actor: ActorContext | null,
): Promise<LlmCreditReservation | null> {
  if (!body) return null;
  let parsed: Record<string, unknown>;
  try {
    const text = typeof body === 'string' ? body : new TextDecoder().decode(body);
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new HTTPException(400, { message: 'LLM proxy requests must include a JSON body so cost can be authorized before upstream execution' });
  }

  const modelId = typeof parsed.model === 'string' ? parsed.model : 'unknown';
  const maxOutputTokensRaw = parsed.max_tokens ?? parsed.max_completion_tokens ?? parsed.max_output_tokens;
  const maxOutputTokens = typeof maxOutputTokensRaw === 'number' && Number.isFinite(maxOutputTokensRaw)
    ? Math.max(0, Math.min(maxOutputTokensRaw, 200_000))
    : 4096;
  const inputText = extractText(parsed.messages ?? parsed.input ?? parsed.prompt ?? '');
  const estimatedInputTokens = Math.ceil(inputText.length / 2);
  const estimatedCost = calculateCost(
    getModel(modelId),
    estimatedInputTokens,
    maxOutputTokens,
    0,
    0,
    markup,
  );
  const minimum = Math.max(0.01, estimatedCost);

  let creditReservation: Awaited<ReturnType<typeof deductLLMCredits>>;
  try {
    creditReservation = await deductLLMCredits(
      accountId,
      modelId,
      estimatedInputTokens,
      maxOutputTokens,
      minimum,
    );
  } catch (error) {
    throw new HTTPException(402, { message: error instanceof Error ? error.message : 'Insufficient credits' });
  }
  if (!creditReservation.success) {
    throw new HTTPException(402, { message: creditReservation.error || 'Insufficient credits' });
  }

  const actorReservedCents = await reserveActorCost(actor, creditReservation.cost, () =>
    grantCredits(
      accountId,
      creditReservation.cost,
      'llm_reservation_refund',
      `LLM reservation refund after member cap: ${modelId}`,
      false,
    ),
  );

  return {
    accountId,
    modelId,
    promptTokens: estimatedInputTokens,
    completionTokens: maxOutputTokens,
    cost: creditReservation.cost,
    actor,
    actorReservedCents,
  };
}

export async function reserveToolProxyCredits(
  accountId: string,
  billingToolName: string,
  actor: ActorContext | null,
  description: string,
): Promise<ToolCreditReservation | null> {
  const expectedCost = getToolCost(billingToolName, 0);
  if (expectedCost <= 0) return null;

  let creditReservation: Awaited<ReturnType<typeof deductToolCredits>>;
  try {
    creditReservation = await deductToolCredits(
      accountId,
      billingToolName,
      0,
      description,
      undefined,
      { skipDevCheck: true },
    );
  } catch (error) {
    throw new HTTPException(402, { message: error instanceof Error ? error.message : 'Insufficient credits' });
  }
  if (!creditReservation.success) {
    throw new HTTPException(402, { message: creditReservation.error || 'Insufficient credits' });
  }

  const actorReservedCents = await reserveActorCost(actor, creditReservation.cost, () =>
    grantCredits(
      accountId,
      creditReservation.cost,
      'tool_reservation_refund',
      `Tool reservation refund after member cap: ${billingToolName}`,
      false,
    ),
  );

  return {
    accountId,
    billingToolName,
    cost: creditReservation.cost,
    actor,
    actorReservedCents,
  };
}

export async function reserveActorCost(
  actor: ActorContext | null,
  cost: number,
  refundCredits: () => Promise<unknown>,
): Promise<number> {
  const cents = dollarsToCents(cost);
  if (!actor || cents <= 0) return 0;

  const reserved = await reserveActorSpend(actor.sandboxId, actor.userId, cents);
  if (reserved.success) return reserved.reservedCents;

  await refundCredits().catch((err) => {
    console.error('[PROXY] Credit refund after member cap failure failed:', err);
  });
  const cap = reserved.capCents === null ? 'configured' : `$${(reserved.capCents / 100).toFixed(2)} / cycle`;
  throw new HTTPException(402, {
    message: `Spending cap reached (${cap}). Ask the instance owner to raise or remove the cap.`,
  });
}

export async function settleLlmReservation(input: {
  accountId: string;
  modelId: string;
  promptTokens: number;
  completionTokens: number;
  actualCost: number;
  reservation: LlmCreditReservation | null;
  actor: ActorContext | null;
  logPrefix: string;
}): Promise<void> {
  const reservedCost = input.reservation?.cost ?? 0;
  const reservedActorCents = input.reservation?.actorReservedCents ?? 0;
  const actor = input.reservation?.actor ?? input.actor;

  if (reservedCost <= 0) {
    const result = await deductLLMCredits(
      input.accountId,
      input.modelId,
      input.promptTokens,
      input.completionTokens,
      input.actualCost,
    );
    if (!result.success) {
      console.error(`[PROXY] ${input.logPrefix} deduction failed: ${result.error || 'unknown error'}`);
      return;
    }
  } else {
    const delta = input.actualCost - reservedCost;
    if (delta > 0.000001) {
      const result = await deductLLMCredits(
        input.accountId,
        input.modelId,
        input.promptTokens,
        input.completionTokens,
        delta,
      );
      if (!result.success) {
        console.error(`[PROXY] ${input.logPrefix} delta deduction failed: ${result.error || 'unknown error'}`);
      }
    } else if (delta < -0.000001) {
      await grantCredits(
        input.accountId,
        Math.abs(delta),
        'llm_reservation_refund',
        `LLM reservation refund: ${input.modelId}`,
        false,
      ).catch((err) => {
        console.error(`[PROXY] ${input.logPrefix} refund failed:`, err);
      });
    }
  }

  if (actor) {
    const actualCents = dollarsToCents(input.actualCost);
    const deltaCents = actualCents - reservedActorCents;
    if (deltaCents > 0) {
      const reserved = await reserveActorSpend(actor.sandboxId, actor.userId, deltaCents);
      if (!reserved.success) {
        console.error(`[PROXY] ${input.logPrefix} actor spend delta exceeded cap`);
      }
    } else if (deltaCents < 0) {
      await refundActorSpend(actor.sandboxId, actor.userId, Math.abs(deltaCents)).catch(
        (err) => console.error('[PROXY] Actor spend refund failed:', err),
      );
    }
  }
}

export async function refundLlmReservation(
  reservation: LlmCreditReservation | null,
  description: string,
): Promise<void> {
  if (!reservation) return;
  if (reservation.cost > 0) {
    await grantCredits(
      reservation.accountId,
      reservation.cost,
      'llm_reservation_refund',
      description,
      false,
    );
  }
  if (reservation.actor && (reservation.actorReservedCents ?? 0) > 0) {
    await refundActorSpend(
      reservation.actor.sandboxId,
      reservation.actor.userId,
      reservation.actorReservedCents ?? 0,
    );
  }
}

export async function refundToolReservation(
  reservation: ToolCreditReservation | null,
  description: string,
): Promise<void> {
  if (!reservation) return;
  if (reservation.cost > 0) {
    await grantCredits(
      reservation.accountId,
      reservation.cost,
      'tool_reservation_refund',
      description,
      false,
    );
  }
  if (reservation.actor && (reservation.actorReservedCents ?? 0) > 0) {
    await refundActorSpend(
      reservation.actor.sandboxId,
      reservation.actor.userId,
      reservation.actorReservedCents ?? 0,
    );
  }
}

export function injectApiKey(
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

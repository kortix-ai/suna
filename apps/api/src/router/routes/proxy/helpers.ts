import { HTTPException } from 'hono/http-exception';
import { wallet } from '../../../billing/wallet';
import { config, getToolCost } from '../../../config';
import { getTraceHeaders } from '../../../lib/request-context';
import { validateAccountToken } from '../../../repositories/account-tokens';
import { validateSecretKey } from '../../../repositories/api-keys';
import type { ActorContext } from '../../../shared/actor-context';
import { isAccountToken, isKortixToken } from '../../../shared/crypto';
import { type ProxyServiceConfig, matchAllowedRoute } from '../../config/proxy-services';
import { deductToolCredits } from '../../services/billing';
import { refundReservation, reserveActorCost } from '../../services/reservation';
import type { AuthResult, ToolCreditReservation } from './app';

// Re-export matchAllowedRoute for handlers (kept here so handlers import from one place)
export { matchAllowedRoute };

/**
 * Resolve ANY Kortix credential to the account it bills.
 *
 * The platform mints two shapes and they live in different tables:
 *   - `kortix_pat_…`  → `account_tokens`   (`validateAccountToken`)
 *   - `kortix_…` / `kortix_sb_…` → `kortix_api_keys` (`validateSecretKey`)
 *
 * The in-sandbox `KORTIX_TOKEN` — the credential every built-in tool presents
 * to this proxy — is the FIRST shape: a session-scoped PAT auto-minted at
 * session create (projects/routes/project-credentials.ts). This resolver only ever consulted
 * the second table, so every built-in tool call answered
 * `401 Invalid Kortix token in x-api-key` while the same token authenticated
 * fine on every other route. Try the right validator for the prefix; never
 * widen what counts as valid (both validators still enforce active + not
 * expired + not revoked).
 */
export async function resolveKortixAccount(token: string): Promise<string | null> {
  if (isAccountToken(token)) {
    const pat = await validateAccountToken(token);
    return pat.isValid && pat.accountId ? pat.accountId : null;
  }
  const key = await validateSecretKey(token);
  return key.isValid && key.accountId ? key.accountId : null;
}

interface KortixTokenSource {
  extract: (c: any) => unknown | Promise<unknown>;
  invalid: string;
  /** Mode 2: the user's own key rides in Authorization; only the account is identified. */
  passthrough?: boolean;
}

// The client shapes the proxy accepts a Kortix credential in, in precedence order.
// The first shape that carries a Kortix-shaped token decides the outcome: a valid
// token authenticates, an invalid one is a hard 401 — never a free passthrough.
const KORTIX_TOKEN_SOURCES: KortixTokenSource[] = [
  {
    // Mode 1: a Kortix token (kortix_/kortix_sb_) in Authorization — full
    // Kortix-managed flow. Everyone else sends "Bearer ", the Replicate SDK
    // "Token ". If it looks like a Kortix token but fails validation → hard reject.
    invalid: 'Invalid Kortix token',
    extract: (c) => {
      const authHeader = c.req.header('Authorization');
      if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7);
      return authHeader?.startsWith('Token ') ? authHeader.slice(6) : undefined;
    },
  },
  {
    // Mode 1b: the Anthropic SDK sends the key via x-api-key; a Kortix token there
    // is Mode 1 (Kortix-managed).
    invalid: 'Invalid Kortix token in x-api-key',
    extract: (c) => c.req.header('x-api-key'),
  },
  {
    // Mode 1c: the Tavily SDK sends the key in the JSON body as "api_key". Check
    // the body for a Kortix token so sandbox tools can auth through the proxy.
    invalid: 'Invalid Kortix token in request body',
    extract: async (c) => {
      if (c.req.method !== 'POST') return undefined;
      const bodyText = await c.req.raw.clone().text();
      if (!bodyText || !bodyText.includes('kortix_')) return undefined;
      return JSON.parse(bodyText)?.api_key;
    },
  },
  {
    // Mode 2: the user's own API key is in Authorization (Bearer) or a
    // provider-specific header (e.g. Anthropic's x-api-key). The Kortix token
    // rides in X-Kortix-Token so we can identify and authorize the account.
    invalid: 'Invalid X-Kortix-Token',
    passthrough: true,
    extract: (c) => c.req.header('X-Kortix-Token'),
  },
];

export async function tryAuthenticate(c: any): Promise<AuthResult> {
  if (!config.DATABASE_URL) return { isKortixUser: false };

  for (const source of KORTIX_TOKEN_SOURCES) {
    let token: string | undefined;
    try {
      const raw = await source.extract(c);
      token = typeof raw === 'string' && isKortixToken(raw) ? raw : undefined;
    } catch (e) {
      // A body that is not JSON carries no api_key: not this shape, try the next.
      if (e instanceof HTTPException) throw e;
      continue;
    }
    if (!token) continue;

    // A Kortix-shaped token resolves, or it hard-rejects below. Never allow an
    // invalid Kortix token to fall through to free passthrough.
    const accountId = await resolveKortixAccount(token).catch(() => null);
    if (!accountId) throw new HTTPException(401, { message: source.invalid });

    return source.passthrough
      ? { isKortixUser: true, accountId, isPassthrough: true }
      : { isKortixUser: true, accountId };
  }

  // Mode 3: no Kortix token anywhere — pure passthrough, no billing.
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

export async function getRequestBody(
  c: any,
  method: string,
): Promise<ArrayBuffer | string | undefined> {
  if (method === 'GET' || method === 'HEAD') return undefined;
  return await c.req.raw.clone().arrayBuffer();
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
    throw new HTTPException(402, {
      message: error instanceof Error ? error.message : 'Insufficient credits',
    });
  }
  if (!creditReservation.success) {
    throw new HTTPException(402, { message: creditReservation.error || 'Insufficient credits' });
  }

  const actorReservedCents = await reserveActorCost(
    actor,
    creditReservation.cost,
    () =>
      wallet.grant({
        accountId,
        amount: creditReservation.cost,
        kind: 'tool_reservation_refund',
        description: `Tool reservation refund after member cap: ${billingToolName}`,
        expiring: false,
        key: null,
      }),
    'PROXY',
  );

  return {
    accountId,
    billingToolName,
    cost: creditReservation.cost,
    actor,
    actorReservedCents,
  };
}

export async function refundToolReservation(
  reservation: ToolCreditReservation | null,
  description: string,
): Promise<void> {
  await refundReservation(reservation, 'tool_reservation_refund', description);
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
        const text = typeof body === 'string' ? body : new TextDecoder().decode(body);
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

import { HTTPException } from 'hono/http-exception';
import { type ProxyServiceConfig } from '../../config/proxy-services';
import { timeUpstream } from '../../../middleware/upstream-timing';
import { config } from '../../../config';
import { logger as appLogger } from '../../../lib/logger';
import { resolveActorFromRequest } from '../../../shared/actor-context';
import { assertSafeEgressUrl, UnsafeEgressError } from '../../../shared/ssrf-guard';
import {
  matchAllowedRoute,
  tryAuthenticate,
  buildForwardHeaders,
  getRequestBody,
  reserveToolProxyCredits,
  refundToolReservation,
  injectApiKey,
} from './helpers';
import { capFirecrawlCrawlLimit } from './crawl-limit';

// === Core Proxy Handler ===
//
// Three authentication/billing modes:
//
// 1. Kortix token (kortix_/kortix_sb_ in our DB) in Authorization header
//    → Inject Kortix's API key, forward, bill the route's tool price.
//
// 2. User's own API key in Authorization + Kortix token in X-Kortix-Token header
//    → Passthrough (no key injection), billed the tool price.
//
// 3. User's own API key, no Kortix token anywhere
//    → Pure passthrough. No billing, no gating (self-hosted / non-Kortix user).

// Firecrawl forwards a caller-supplied `url` body field to its own fetcher.
// Reject loopback / link-local (cloud metadata) / private / non-http(s) targets
// here, before the credit reservation and the upstream hop, so SSRF protection
// never depends on the upstream service or on the caller's credit balance.
async function assertSafeFirecrawlTarget(
  c: any,
  service: ProxyServiceConfig,
  method: string,
): Promise<void> {
  if (service.name !== 'firecrawl' || method.toUpperCase() !== 'POST') return;
  const body = await getRequestBody(c, method);
  if (!body) return;
  let url: unknown;
  try {
    const text = typeof body === 'string' ? body : new TextDecoder().decode(body);
    url = JSON.parse(text)?.url;
  } catch {
    return; // no JSON body — the upstream rejects it
  }
  if (typeof url !== 'string' || url.length === 0) return; // routes with no url field
  try {
    await assertSafeEgressUrl(url, { allowHttp: true });
  } catch (error) {
    if (error instanceof UnsafeEgressError) {
      throw new HTTPException(400, {
        message: 'URL not allowed: only public http(s) targets may be fetched',
      });
    }
    throw error;
  }
}

export async function handleProxy(c: any, service: ProxyServiceConfig, prefix: string) {
  const fullPath = new URL(c.req.url).pathname;
  const prefixStr = `/${prefix}`;
  // Find the prefix anywhere in the path (handles mount-point prefixing by Hono)
  const prefixIdx = fullPath.indexOf(prefixStr);
  const subPath = prefixIdx !== -1 ? fullPath.slice(prefixIdx + prefixStr.length) || '/' : '/';
  const queryString = new URL(c.req.url).search;
  const method = c.req.method;

  await assertSafeFirecrawlTarget(c, service, method);

  const auth = await tryAuthenticate(c);

  if (auth.isKortixUser && auth.accountId && !auth.isPassthrough) {
    // Mode 1: Kortix-owned key — inject our key, bill the tool price
    return handleKortixProxy(c, service, subPath, queryString, method, auth.accountId);
  } else if (auth.isPassthrough && auth.accountId) {
    // Mode 2: User's own key — passthrough, billed the tool price.
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

/**
 * One upstream dispatch for all three auth modes (the fetch block used to be
 * duplicated three times, KRTX-2073). Forward the upstream response verbatim
 * — a provider's own 500 is the provider's answer, not ours to rewrite.
 *
 * A passed-through status never throws, so a provider-side 5xx used to be
 * invisible in the logs: no error line, no reason, just a status in the
 * completion line (36×500 on firecrawl /v2/scrape in 7 minutes, avg ≈46 s,
 * zero error-level log lines). When the upstream answers 5xx, read its error
 * body once and emit ONE bounded warn that names the service, the route and
 * the upstream's own reason, with URLs masked (the target is caller data).
 * 4xx stays silent: an expected, high-volume outcome the client handles.
 *
 * `reservation` refunds exactly as before: awaited on a dispatch error,
 * fire-and-forget on an upstream error; null for the unbilled pure
 * passthrough mode.
 */
async function forwardUpstream(
  service: ProxyServiceConfig,
  method: string,
  subPath: string,
  targetUrl: string,
  headers: Headers,
  body: Awaited<ReturnType<typeof getRequestBody>>,
  reservation: Awaited<ReturnType<typeof reserveToolProxyCredits>>,
): Promise<Response> {
  let upstream: Response;
  try {
    // Attribute the upstream wait to `upstream_ms` so the completion log line
    // can split provider latency from this API's own work (auth, reservation).
    upstream = await timeUpstream(() =>
      fetch(targetUrl, {
        method,
        headers,
        body,
        // @ts-ignore
        duplex: 'half',
      }),
    );
  } catch (error) {
    if (reservation) {
      await refundToolReservation(
        reservation,
        `Tool reservation refund after dispatch error: ${service.name}`,
      ).catch((refundError) =>
        console.error('[PROXY] Tool reservation refund failed:', refundError),
      );
    }
    throw error;
  }

  if (!upstream.ok && reservation) {
    refundToolReservation(
      reservation,
      `Tool reservation refund after upstream error: ${service.name}`,
    ).catch((err) => console.error('[PROXY] Tool reservation refund failed:', err));
  }

  if (upstream.status >= 500) {
    let text: string | null = null;
    try {
      text = await upstream.text();
    } catch {
      text = null; // body already disturbed — pass the status through bodyless
    }
    const reason =
      text === null
        ? '(unreadable body)'
        : text
            .slice(0, 300)
            .replace(/https?:\/\/\S+/g, '<url>')
            .replace(/\s+/g, ' ')
            .trim() || '(no body)';
    appLogger.warn(
      `[PROXY] ${service.name} upstream ${upstream.status} on ${method} ${subPath}: ${reason}`,
      { upstream_status: upstream.status, upstream_reason: reason },
    );
    return new Response(text, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    });
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  });
}

/**
 * What a provider answers when it refuses or limits the ACCOUNT behind the key:
 * a refused key (401), no credit (402), a rate limit (429), and Tavily's plan
 * and pay-as-you-go limits (432, 433). On the Kortix-owned key that account is
 * Kortix's, so passing the provider's text through told a user to "upgrade
 * your plan" for a plan they do not have, and logged nothing (KRTX-3022).
 * 400 and 403 stay as they are: they are about the request (Firecrawl answers
 * 403 for a site it will not read).
 */
const PLATFORM_ACCOUNT_REFUSALS = new Set([401, 402, 429, 432, 433]);

/** The capability a person loses, named the way the product names it. */
const TOOL_LABELS: Record<string, string> = {
  tavily: 'Web search',
  serper: 'Image search',
  firecrawl: 'Reading web pages',
};

async function platformKeyRefusal(service: ProxyServiceConfig, response: Response): Promise<Response | null> {
  if (!PLATFORM_ACCOUNT_REFUSALS.has(response.status)) return null;
  const reason = (await response.text().catch(() => ''))
    .slice(0, 300)
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/\s+/g, ' ')
    .trim();
  appLogger.error(`[PROXY] ${service.name} refused Kortix's key: upstream ${response.status}`, {
    upstream_status: response.status,
    upstream_reason: reason || '(no body)',
  });
  const tool = TOOL_LABELS[service.name] ?? `The ${service.name} tool`;
  const cause =
    response.status === 401
      ? "the provider is not accepting Kortix's key"
      : "Kortix's account with the provider is over its usage limit";
  const headers = new Headers({ 'Content-Type': 'application/json' });
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter) headers.set('Retry-After', retryAfter);
  return new Response(
    JSON.stringify({
      error: 'tool_unavailable',
      service: service.name,
      upstream_status: response.status,
      message: `${tool} is unavailable right now: ${cause}. This is not a limit on your account, and there is nothing to change on your side.`,
    }),
    { status: 503, headers },
  );
}

// === Kortix User: match allowed route, inject our key, bill with route-specific pricing ===

async function handleKortixProxy(
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

  const kortixKey = service.getKortixApiKey();
  if (!kortixKey) {
    throw new HTTPException(503, {
      message: `${service.name} not configured`,
    });
  }

  const actor = resolveActorFromRequest(c, { logPrefix: '[PROXY]' });

  const targetUrl = `${service.targetBaseUrl}${subPath}${queryString}`;
  const headers = buildForwardHeaders(c);
  // Strip Kortix-specific and auth headers — upstream gets injected key only
  headers.delete('x-kortix-token');
  headers.delete('x-api-key');
  headers.delete('authorization');
  let body = await getRequestBody(c, method);

  body = injectApiKey(service, headers, body);
  body = capFirecrawlCrawlLimit(service, method, subPath, body, headers);
  // Route-specific billing overrides service default.
  const billingToolName = matchedRoute.billingToolName || service.billingToolName;
  const toolReservation = await reserveToolProxyCredits(
    accountId,
    billingToolName,
    actor,
    `Proxy ${service.name}: ${method} ${subPath}`,
  );

  console.log(
    `[PROXY] ${service.name} (kortix:${accountId}) ${method} ${subPath} → ${targetUrl} [bill:${billingToolName}]`,
  );

  const response = await forwardUpstream(service, method, subPath, targetUrl, headers, body, toolReservation);
  return (await platformKeyRefusal(service, response)) ?? response;
}

// === Kortix user with own key: passthrough, billed the tool price ===

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
  const body = await getRequestBody(c, method);

  const toolReservation = await reserveToolProxyCredits(
    accountId,
    service.billingToolName,
    null,
    `Passthrough ${service.name}: ${method} ${subPath}`,
  );

  console.log(`[PROXY] ${service.name} (passthrough:${accountId}) ${method} ${subPath} → ${targetUrl}`);

  return forwardUpstream(service, method, subPath, targetUrl, headers, body, toolReservation);
}

// === Not Kortix user: pure passthrough ===

async function handlePassthrough(
  c: any,
  service: ProxyServiceConfig,
  subPath: string,
  queryString: string,
  method: string,
) {
  const targetUrl = `${service.targetBaseUrl}${subPath}${queryString}`;
  const headers = buildForwardHeaders(c);
  const body = await getRequestBody(c, method);

  console.log(`[PROXY] ${service.name} (passthrough) ${method} ${subPath}`);

  return forwardUpstream(service, method, subPath, targetUrl, headers, body, null);
}

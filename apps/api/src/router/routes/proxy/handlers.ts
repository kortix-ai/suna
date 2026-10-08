import { HTTPException } from 'hono/http-exception';
import { type ProxyServiceConfig } from '../../config/proxy-services';
import { timeUpstream } from '../../../middleware/upstream-timing';
import { config } from '../../../config';
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
    await refundToolReservation(
      toolReservation,
      `Tool reservation refund after dispatch error: ${service.name}`,
    ).catch((refundError) =>
      console.error('[PROXY] Tool reservation refund failed:', refundError),
    );
    throw error;
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

  let upstream: Response;
  try {
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
    await refundToolReservation(
      toolReservation,
      `Tool reservation refund after dispatch error: ${service.name}`,
    ).catch((refundError) =>
      console.error('[PROXY] Tool reservation refund failed:', refundError),
    );
    throw error;
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

  const upstream = await timeUpstream(() =>
    fetch(targetUrl, {
      method,
      headers,
      body,
      // @ts-ignore
      duplex: 'half',
    }),
  );

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  });
}

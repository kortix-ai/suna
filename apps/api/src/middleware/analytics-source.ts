/**
 * The surface a request came from, as the `source` property of a product
 * analytics event (shared/product-analytics.ts). An agent session's own token
 * is `agent`; otherwise the client's `X-Kortix-Client-Version`
 * (`web/…`, `cli/…`, `mobile/…`, `desktop/…`) names it; otherwise the
 * credential kind does. Telemetry only: a client can send any header value,
 * so this never decides access.
 */
import type { Context } from 'hono';

export type AnalyticsSource =
  | 'web'
  | 'cli'
  | 'mobile'
  | 'desktop'
  | 'agent'
  | 'api_key'
  | 'automation'
  | 'oauth';

const CLIENT_SURFACES = new Set<AnalyticsSource>(['web', 'cli', 'mobile', 'desktop']);

export function analyticsSource(c: Context): AnalyticsSource {
  const authType = c.get('authType') as string | undefined;
  if (authType === 'apiKey' && c.get('apiKeyType') === 'sandbox') return 'agent';
  const surface = c.req
    .header('x-kortix-client-version')
    ?.trim()
    .split('/', 1)[0]
    ?.toLowerCase() as AnalyticsSource | undefined;
  if (surface && CLIENT_SURFACES.has(surface)) return surface;
  if (authType === 'pat' || authType === 'apiKey') return 'api_key';
  if (authType === 'service_account') return 'automation';
  if (authType === 'oauth') return 'oauth';
  return 'web';
}

const PERSON_SOURCES = new Set<AnalyticsSource>(['web', 'cli', 'mobile', 'desktop']);

/** A person's own client, not an agent, an API key, a service account or an OAuth app. */
export function isPersonSource(source: AnalyticsSource): boolean {
  return PERSON_SOURCES.has(source);
}

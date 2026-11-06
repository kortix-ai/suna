/**
 * Self-host alias domains (KORTIX_DOMAIN_ALIASES): extra domains one instance
 * serves in full, next to its primary domain (the host of FRONTEND_URL).
 *
 * The reverse proxy serves every alias host exactly like its primary twin:
 * `<alias>` is the web app, `api.<alias>` the API, `*.apps.<alias>` and
 * `*.p.<alias>` Apps and previews. A request records which alias it arrived on
 * (see the request-context middleware in http-middleware.ts), and every URL the
 * API builds for that request moves onto the same alias. A user on an alias
 * never gets a link back to a domain their network may block.
 *
 * Background work has no request and stays on the primary domain: emails,
 * sandbox callbacks (KORTIX_URL) and webhooks.
 */
import { config } from '../config';
import { getRequestContext } from '../lib/request-context';

/** The request-context field that names the alias a request arrived on. */
export const DOMAIN_ALIAS_CONTEXT_FIELD = 'domainAlias';

function normalizeDomain(value: string | null | undefined): string {
  return (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/:\d+$/, '')
    .replace(/^\.+|\.+$/g, '');
}

function hostOf(url: string | null | undefined): string | null {
  try {
    return url ? new URL(url).hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** The primary domain: the host of FRONTEND_URL. Null for a local or unset frontend. */
export function primaryDomain(): string | null {
  const host = hostOf(config.FRONTEND_URL);
  if (!host || host === 'localhost' || !host.includes('.')) return null;
  return host;
}

/** The configured alias domains, primary excluded. Empty without a primary domain. */
export function domainAliases(): string[] {
  const primary = primaryDomain();
  if (!primary) return [];
  const out: string[] = [];
  for (const entry of (config.KORTIX_DOMAIN_ALIASES ?? '').split(/[\s,]+/)) {
    const domain = normalizeDomain(entry);
    if (domain && domain.includes('.') && domain !== primary && !out.includes(domain)) out.push(domain);
  }
  return out;
}

/** `domain` moved from under `from` to under `to`, or null when it does not sit under `from`. */
export function rebaseDomain(domain: string, from: string, to: string): string | null {
  if (domain === from) return to;
  if (domain.endsWith(`.${from}`)) return `${domain.slice(0, -from.length)}${to}`;
  return null;
}

/** The alias domain a hostname belongs to (`<alias>` or any `*.<alias>`), else null. */
export function aliasForHost(hostname: string | null | undefined): string | null {
  const host = normalizeDomain(hostname);
  if (!host) return null;
  // Longest first: an alias that is a subdomain of another alias wins.
  const aliases = domainAliases().sort((a, b) => b.length - a.length);
  return aliases.find((alias) => host === alias || host.endsWith(`.${alias}`)) ?? null;
}

/** The alias the current request arrived on, or null (primary domain, or no request). */
export function requestDomainAlias(): string | null {
  const alias = getRequestContext()?.[DOMAIN_ALIAS_CONTEXT_FIELD];
  return alias && domainAliases().includes(alias) ? alias : null;
}

/**
 * A primary-domain hostname moved onto the alias the current request arrived
 * on. Unchanged when the request is on the primary domain, when there is no
 * request, or when `domain` does not sit under the primary domain.
 */
export function forRequestDomain(domain: string): string {
  const alias = requestDomainAlias();
  const primary = primaryDomain();
  if (!alias || !primary) return domain;
  return rebaseDomain(domain, primary, alias) ?? domain;
}

/** Each alias form of a primary-domain hostname (`apps.<primary>` → `apps.<alias>`, …). */
export function aliasFormsOf(domain: string | null): string[] {
  const primary = primaryDomain();
  if (!domain || !primary) return [];
  return domainAliases()
    .map((alias) => rebaseDomain(domain, primary, alias))
    .filter((d): d is string => d !== null);
}

/** The alias web-app origins: browsers on them may call this API. */
export function aliasFrontendOrigins(): string[] {
  const primary = primaryDomain();
  if (!primary) return [];
  return domainAliases().map((alias) => `https://${alias}`);
}

/** Alias web-app and API origins, for the CORS allowlist. */
export function aliasCorsOrigins(): string[] {
  const apiHost = hostOf(config.KORTIX_URL);
  return [...aliasFrontendOrigins(), ...aliasFormsOf(apiHost).map((host) => `https://${host}`)];
}

/** The configured CORS origins beyond the built-in list: `CORS_ALLOWED_ORIGINS` and the alias domains. */
export function configuredCorsOrigins(): string[] {
  return [
    ...(config.CORS_ALLOWED_ORIGINS ?? '').split(',').map((origin) => origin.trim()).filter(Boolean),
    // Self-host alias domains serve the same web app.
    ...aliasCorsOrigins(),
  ];
}

/**
 * A stored absolute URL on an API host this instance serves (the primary API
 * host or one of its alias forms), moved onto the API host of the current
 * request's domain. A session row keeps the API host it was created under
 * (`sandbox_url`, a sandbox row's `base_url`): after a domain move, or for a
 * visitor on an alias, the browser must call the API on the domain it is
 * using, never on one its network may block. Any other URL, and a URL outside
 * a request, is returned unchanged.
 */
export function forRequestApiUrl(url: string | null): string | null {
  if (!url) return url;
  const apiHost = hostOf(config.KORTIX_URL);
  if (!apiHost) return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== apiHost && !aliasFormsOf(apiHost).includes(host)) return url;
  const target = forRequestDomain(apiHost);
  if (host === target) return url;
  parsed.hostname = target;
  return parsed.toString();
}

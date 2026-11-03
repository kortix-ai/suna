/**
 * Domain aliases: one self-host instance serves its primary domain
 * (KORTIX_DOMAIN) and any number of extra or former domains
 * (KORTIX_DOMAIN_ALIASES, comma-separated) in full.
 *
 * Each alias `<a>` is a peer of the primary domain: Caddy serves `<a>` (web
 * app), `api.<a>`, `*.apps.<a>` and `*.p.<a>` exactly like their primary twins.
 * The frontend hands a page on `<a>` runtime URLs on `<a>`, and the API builds
 * App and preview URLs on the domain a request arrived on, so a visitor on an
 * alias never gets a link to a domain their network may block. Background work
 * (emails, sandbox callbacks, webhooks) stays on the primary domain.
 *
 * Alias hosts are derived from the primary ones: a host under the primary
 * domain (`api.<primary>`, `apps.<primary>`, `p.<primary>`) has the same prefix
 * under each alias. A host outside the primary domain has no alias form.
 */

export interface DomainAliasHosts {
  /** Web-app hosts, served like KORTIX_DOMAIN. */
  app: string[];
  /** API hosts served like KORTIX_API_DOMAIN. */
  api: string[];
  /** Apps base domains served like KORTIX_APPS_BASE_DOMAIN (`*.<base>`). */
  apps: string[];
  /** Preview base domains served like KORTIX_PREVIEW_BASE_DOMAIN (`*.<base>`). */
  preview: string[];
}

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOSTNAME = new RegExp(`^(?=.{1,253}$)${LABEL}(?:\\.${LABEL})+$`);

/** Lowercase a domain, drop a scheme, path, port and trailing dot. Null if it is not a hostname. */
export function normalizeHostname(raw: string | null | undefined): string | null {
  const host = (raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/:\d+$/, '')
    .replace(/\.$/, '');
  return HOSTNAME.test(host) ? host : null;
}

/** Split a comma- or space-separated domain list. Throws on an entry that is not a hostname. */
export function parseDomainList(raw: string | null | undefined): string[] {
  const out: string[] = [];
  for (const entry of (raw ?? '').split(/[\s,]+/)) {
    if (!entry) continue;
    const host = normalizeHostname(entry);
    if (!host) throw new Error(`"${entry}" is not a valid domain name`);
    if (!out.includes(host)) out.push(host);
  }
  return out;
}

/**
 * `host` moved from under `fromDomain` to under `toDomain`, or null when `host`
 * does not sit under `fromDomain`.
 */
export function rebaseHost(host: string | null | undefined, fromDomain: string, toDomain: string): string | null {
  const h = normalizeHostname(host);
  if (!h) return null;
  if (h === fromDomain) return toDomain;
  if (h.endsWith(`.${fromDomain}`)) return `${h.slice(0, -fromDomain.length)}${toDomain}`;
  return null;
}

type DomainEnv = Partial<Record<string, string>>;

/** Every alias host this instance answers on. Empty without a primary domain. */
export function deriveDomainAliasHosts(env: DomainEnv): DomainAliasHosts {
  const hosts: DomainAliasHosts = { app: [], api: [], apps: [], preview: [] };
  const primary = normalizeHostname(env.KORTIX_DOMAIN);
  if (!primary) return hosts;
  const push = (list: string[], host: string | null) => {
    if (host && !list.includes(host)) list.push(host);
  };
  for (const alias of parseDomainList(env.KORTIX_DOMAIN_ALIASES)) {
    if (alias === primary) continue;
    push(hosts.app, alias);
    push(hosts.api, rebaseHost(env.KORTIX_API_DOMAIN || `api.${primary}`, primary, alias));
    if (env.KORTIX_APPS_BASE_DOMAIN?.trim()) push(hosts.apps, rebaseHost(env.KORTIX_APPS_BASE_DOMAIN, primary, alias));
    if (env.KORTIX_PREVIEW_BASE_DOMAIN?.trim()) {
      push(hosts.preview, rebaseHost(env.KORTIX_PREVIEW_BASE_DOMAIN, primary, alias));
    }
  }
  return hosts;
}

export interface DomainMovePlan {
  /** The keys to write, with their new values. */
  changes: Record<string, string>;
  from: string;
  to: string;
}

/**
 * Move the primary domain to `newDomain` and keep the old one as an alias.
 * Every host that sat under the old domain moves with it; the ACME contact
 * moves only when it was the derived `admin@<old>` default.
 */
export function planDomainMove(env: DomainEnv, newDomain: string): DomainMovePlan {
  const from = normalizeHostname(env.KORTIX_DOMAIN);
  if (!from) throw new Error('This instance has no domain (KORTIX_DOMAIN). Use `kortix self-host init --domain <domain>`.');
  const to = normalizeHostname(newDomain);
  if (!to) throw new Error(`"${newDomain}" is not a valid domain name`);
  if (to === from) throw new Error(`${to} is already the primary domain`);

  const changes: Record<string, string> = { KORTIX_DOMAIN: to };
  const apiDomain = env.KORTIX_API_DOMAIN || `api.${from}`;
  changes.KORTIX_API_DOMAIN = rebaseHost(apiDomain, from, to) ?? apiDomain;
  for (const key of ['KORTIX_APPS_BASE_DOMAIN', 'KORTIX_PREVIEW_BASE_DOMAIN'] as const) {
    const current = env[key]?.trim();
    if (current) changes[key] = rebaseHost(current, from, to) ?? current;
  }
  if (env.KORTIX_ACME_EMAIL === `admin@${from}`) changes.KORTIX_ACME_EMAIL = `admin@${to}`;
  const aliases = [from, ...parseDomainList(env.KORTIX_DOMAIN_ALIASES)].filter((d) => d !== to);
  changes.KORTIX_DOMAIN_ALIASES = [...new Set(aliases)].join(',');
  return { changes, from, to };
}

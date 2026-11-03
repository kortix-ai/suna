/**
 * Self-host alias domains (KORTIX_DOMAIN_ALIASES): one instance serves its web
 * app on the primary domain and on each alias. A page served on an alias must
 * call the API and auth on that same alias, never on the primary domain, which
 * the visitor's network may block. So the runtime config follows the Host the
 * page was requested on.
 *
 * Only a configured alias is honored: an arbitrary Host header leaves the
 * config untouched.
 */

/** The runtime-config URLs that point at this instance. */
const INSTANCE_URL_KEYS = ['SUPABASE_URL', 'BACKEND_URL', 'APP_URL'] as const;

function normalizeHost(value: string | null | undefined): string {
  return (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/:\d+$/, '')
    .replace(/\.$/, '');
}

function rebaseUrl(url: string, from: string, to: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (host === from) parsed.hostname = to;
    else if (host.endsWith(`.${from}`)) parsed.hostname = `${host.slice(0, -from.length)}${to}`;
    else return url;
    // URL.toString() adds a trailing slash to a bare origin; keep the input's form.
    const out = parsed.toString();
    return url.endsWith('/') || !out.endsWith('/') ? out : out.slice(0, -1);
  } catch {
    return url;
  }
}

/**
 * The runtime config for a page requested on `requestHost`. When that host is a
 * configured alias of the primary domain (the host of APP_URL), every instance
 * URL moves onto the alias.
 */
export function withDomainAlias<T extends Partial<Record<(typeof INSTANCE_URL_KEYS)[number], string | undefined>>>(
  env: T,
  requestHost: string | null | undefined,
  aliasesCsv: string | null | undefined,
): T {
  const host = normalizeHost(requestHost);
  let primary = '';
  try {
    primary = env.APP_URL ? new URL(env.APP_URL).hostname.toLowerCase() : '';
  } catch {
    return env;
  }
  if (!host || !primary || host === primary) return env;
  const aliases = (aliasesCsv ?? '').split(/[\s,]+/).map(normalizeHost).filter(Boolean);
  if (!aliases.includes(host)) return env;
  const out = { ...env };
  for (const key of INSTANCE_URL_KEYS) {
    const value = out[key];
    if (typeof value === 'string' && value) (out as Record<string, unknown>)[key] = rebaseUrl(value, primary, host);
  }
  return out;
}

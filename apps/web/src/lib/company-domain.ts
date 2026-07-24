/**
 * Client-side validation for the optional company-domain field.
 *
 * The backend normalizes and re-validates whatever it receives, and quietly
 * ignores a value it cannot use so an optional field can never fail project
 * creation. That safety net is exactly why this exists: without a check here,
 * a typo would be silently dropped and the user would simply never get the
 * company profile they asked for, with nothing on screen explaining why.
 *
 * Kept deliberately close to the server's rules (apps/api enrichment
 * `normalizeDomain`) so the two agree on what is acceptable.
 */

const LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const TLD = /^(xn--[a-z0-9-]+|[a-z]{2,})$/;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

const MAX_DOMAIN_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;

/**
 * Reduce user input (a bare domain or a pasted URL) to a canonical apex host,
 * or return null when it is not a usable public domain.
 */
export function normalizeCompanyDomain(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (parsed.username || parsed.password) return null;
  if (parsed.port && parsed.port !== '443' && parsed.port !== '80') return null;

  let host = parsed.hostname.toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host.startsWith('www.')) host = host.slice(4);

  if (!host || host.length > MAX_DOMAIN_LENGTH) return null;
  if (IPV4.test(host) || host.includes(':') || host.startsWith('[')) return null;

  const labels = host.split('.');
  if (labels.length < 2) return null;
  for (const label of labels) {
    if (!label || label.length > MAX_LABEL_LENGTH || !LABEL.test(label)) return null;
  }
  if (!TLD.test(labels[labels.length - 1])) return null;

  return host;
}

export function isValidCompanyDomain(raw: string): boolean {
  return normalizeCompanyDomain(raw) !== null;
}

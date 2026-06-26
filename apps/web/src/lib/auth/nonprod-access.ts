const DEFAULT_RESTRICTED_DOMAINS = ['kortix.ai', 'kortix.com'];
const RESTRICTED_HOSTS = new Set(['dev.kortix.com', 'staging.kortix.com']);

export const RESTRICTED_ENV_AUTH_MESSAGE =
  'This environment is restricted to the Kortix team. Use your Kortix email address.';

function splitList(value?: string | null): string[] {
  return (value || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function originHost(value?: string | null): string | null {
  if (!value || value.startsWith('encrypted:')) return null;
  try {
    const candidate = value.startsWith('http') ? value : `https://${value}`;
    return new URL(candidate).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function isRestrictedAuthEnvironment({
  origin,
  appUrl,
}: {
  origin?: string | null;
  appUrl?: string | null;
}): boolean {
  const mode = (process.env.KORTIX_AUTH_ACCESS_MODE || '').trim().toLowerCase();
  if (mode === 'open') return false;
  if (mode === 'restricted') return true;

  const hosts = [
    originHost(origin),
    originHost(appUrl),
    originHost(process.env.KORTIX_PUBLIC_APP_URL),
    originHost(process.env.NEXT_PUBLIC_APP_URL),
    originHost(process.env.NEXT_PUBLIC_URL),
    originHost(process.env.PUBLIC_URL),
    originHost(process.env.VERCEL_URL),
  ].filter(Boolean);

  return hosts.some((host) => host !== null && RESTRICTED_HOSTS.has(host));
}

export function isEmailAllowedForRestrictedAuth(email?: string | null): boolean {
  const normalized = (email || '').trim().toLowerCase();
  const at = normalized.lastIndexOf('@');
  if (at <= 0) return false;

  const exactEmails = splitList(process.env.KORTIX_AUTH_ALLOWED_EMAILS);
  if (exactEmails.includes(normalized)) return true;

  const configuredDomains = splitList(process.env.KORTIX_AUTH_ALLOWED_EMAIL_DOMAINS);
  const domains = configuredDomains.length > 0 ? configuredDomains : DEFAULT_RESTRICTED_DOMAINS;
  const domain = normalized.slice(at + 1);

  return domains.includes(domain);
}

export function restrictedAuthDecision({
  email,
  origin,
  appUrl,
}: {
  email?: string | null;
  origin?: string | null;
  appUrl?: string | null;
}): { restricted: boolean; allowed: boolean; message?: string } {
  const restricted = isRestrictedAuthEnvironment({ origin, appUrl });
  if (!restricted) return { restricted: false, allowed: true };
  if (isEmailAllowedForRestrictedAuth(email)) return { restricted: true, allowed: true };
  return {
    restricted: true,
    allowed: false,
    message: RESTRICTED_ENV_AUTH_MESSAGE,
  };
}

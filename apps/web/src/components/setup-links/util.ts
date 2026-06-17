import { getEnv } from '@/lib/env-config';

/** API base (already includes the /v1 suffix), e.g. https://api.kortix.com/v1. */
export function setupLinkApiBase(): string {
  return (getEnv().BACKEND_URL || 'http://localhost:8008/v1').replace(/\/+$/, '');
}

export type SetupLinkKind = 'secret' | 'connector';

/**
 * Recognize an agent-minted setup link. The agent emits an ABSOLUTE url
 * (`${FRONTEND_URL}/secret-intake/<token>` or `/connect/<token>`) so it stays a
 * plain tappable link in Slack; inside the web app that origin equals our own,
 * so we intercept it and render an in-app modal instead of navigating away.
 */
export function parseSetupLinkHref(
  href?: string,
): { kind: SetupLinkKind; token: string } | null {
  if (!href) return null;
  let pathname = href;
  if (/^https?:\/\//i.test(href)) {
    try {
      const u = new URL(href);
      if (typeof window !== 'undefined' && u.origin !== window.location.origin) return null;
      pathname = u.pathname;
    } catch {
      return null;
    }
  }
  const m = pathname.match(/^\/(secret-intake|connect)\/([^/?#]+)/);
  if (!m) return null;
  return { kind: m[1] === 'secret-intake' ? 'secret' : 'connector', token: decodeURIComponent(m[2]) };
}

import { getEnv } from '@/lib/env-config';
import { HostBoundaryError } from '@kortix/sdk';

/** API base (already includes the /v1 suffix), e.g. https://api.dosco.live/v1. */
export function setupLinkApiBase(): string {
  return (getEnv().BACKEND_URL || 'http://localhost:8008/v1').replace(/\/+$/, '');
}

/**
 * Maps a failed setup-link request to the state the human should see. The API
 * distinguishes an expired link (410 — expected, recoverable by re-minting)
 * from an unknown/mangled one (404 — usually a truncated copy); collapsing
 * both into one generic "invalid" message left humans stuck with no way
 * forward.
 */
export function classifySetupLinkError(cause: unknown): 'expired' | 'invalid' | 'network' {
  const status =
    cause instanceof HostBoundaryError
      ? cause.status
      : typeof (cause as { status?: unknown } | null | undefined)?.status === 'number'
        ? (cause as { status: number }).status
        : null;
  if (status === 410) return 'expired';
  if (status === 404 || status === 400) return 'invalid';
  return 'network';
}

/** "6 days" / "3 hours" / "25 minutes" until the link dies; null once past. */
export function describeLinkExpiry(expiresAtIso: string, nowMs: number): string | null {
  const expiresMs = Date.parse(expiresAtIso);
  if (Number.isNaN(expiresMs) || expiresMs <= nowMs) return null;
  const minutes = Math.round((expiresMs - nowMs) / 60_000);
  if (minutes >= 2 * 24 * 60) return `${Math.round(minutes / (24 * 60))} days`;
  if (minutes >= 2 * 60) return `${Math.round(minutes / 60)} hours`;
  if (minutes >= 2) return `${minutes} minutes`;
  return 'less than 2 minutes';
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
  let sameOrigin = true;
  if (/^https?:\/\//i.test(href)) {
    try {
      const u = new URL(href);
      sameOrigin =
        typeof window === 'undefined' || u.origin === window.location.origin;
      pathname = u.pathname;
    } catch {
      return null;
    }
  }
  const m = pathname.match(/^\/(secret-intake|connect)\/([^/?#]+)/);
  if (!m) return null;
  const token = decodeURIComponent(m[2]);
  // Links are minted against FRONTEND_URL, which can differ from the origin the
  // app is being viewed on (staging, preview deploys, self-host behind another
  // domain). A cross-origin URL is still ours when it carries the `ksl_` wire
  // prefix — the token is HMAC-verified server-side, so intercepting can never
  // hand a foreign form our data. Anything else stays a plain link.
  if (!sameOrigin && !token.startsWith('ksl_')) return null;
  return { kind: m[1] === 'secret-intake' ? 'secret' : 'connector', token };
}

/**
 * Agents usually emit the setup link as a bare URL, so the markdown link text
 * IS the URL — a few hundred opaque token characters. That never belongs on
 * the chip. Only keep the author's text when it reads like a human label.
 */
export function setupLinkChipLabel(raw: string, token: string, fallback: string): string {
  const text = raw.trim();
  if (!text) return fallback;
  const looksLikeUrl =
    /^https?:\/\//i.test(text) ||
    text.includes(token) ||
    text.includes('/secret-intake/') ||
    text.includes('/connect/') ||
    (text.length > 48 && !text.includes(' '));
  return looksLikeUrl ? fallback : text;
}

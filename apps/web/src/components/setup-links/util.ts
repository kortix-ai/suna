import { getEnv } from '@/lib/env-config';
import { HostBoundaryError } from '@kortix/sdk';
import { openMarkdownLinkAtEnd } from '@kortix/shared';

/** API base (already includes the /v1 suffix), e.g. https://api.kortix.com/v1. */
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

export type TextLinkPart =
  { type: 'text'; value: string } | { type: 'link'; href: string; label: string };

/**
 * `[label](https://…)` or a bare `https://…`. http(s) only: this runs on
 * agent-written text, which must never become a `javascript:` href.
 */
const TEXT_LINK_PATTERN = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|https?:\/\/[^\s<>]+/g;

/** Prose punctuation that ends a sentence after a bare URL but is not part of it. */
const URL_TRAILING_PUNCTUATION = /[.,;:!?'")\]]+$/;

/**
 * Splits agent-written field hints ("Create one at https://…") into text and
 * link parts, so the form renders the URL as a real link instead of dead text.
 */
export function splitTextLinks(text: string): TextLinkPart[] {
  const parts: TextLinkPart[] = [];
  let cursor = 0;
  for (const match of text.matchAll(TEXT_LINK_PATTERN)) {
    const start = match.index ?? 0;
    const [whole, markdownLabel, markdownHref] = match;
    const href = markdownHref ?? whole.replace(URL_TRAILING_PUNCTUATION, '');
    const label = markdownLabel ?? href.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
    if (start > cursor) parts.push({ type: 'text', value: text.slice(cursor, start) });
    parts.push({ type: 'link', href, label: label || href });
    cursor = start + (markdownHref ? whole.length : href.length);
  }
  if (cursor < text.length) parts.push({ type: 'text', value: text.slice(cursor) });
  return parts;
}

export type SetupLinkKind = 'secret' | 'connector';

/**
 * Recognize an agent-minted setup link. The agent emits an ABSOLUTE url
 * (`${FRONTEND_URL}/secret-intake/<token>` or `/connect/<token>`) so it stays a
 * plain tappable link in Slack; inside the web app that origin equals our own,
 * so we intercept it and render an in-app modal instead of navigating away.
 */
export function parseSetupLinkHref(href?: string): { kind: SetupLinkKind; token: string } | null {
  if (!href) return null;
  let pathname = href;
  let sameOrigin = true;
  if (/^https?:\/\//i.test(href)) {
    try {
      const u = new URL(href);
      sameOrigin = typeof window === 'undefined' || u.origin === window.location.origin;
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
 * The kind of setup link a URL that is still streaming will become, or null.
 *
 * `parseSetupLinkHref` needs the whole token. This answers as soon as the path
 * names a setup route, and applies the same origin rule to the part so far: a
 * cross-origin URL counts only while its token can still start with `ksl_`.
 */
export function partialSetupLinkKind(partial: string): SetupLinkKind | null {
  const text = partial.trim();
  let pathname = text;
  let sameOrigin = true;
  if (/^https?:\/\//i.test(text)) {
    try {
      const u = new URL(text);
      sameOrigin = typeof window === 'undefined' || u.origin === window.location.origin;
      pathname = u.pathname;
    } catch {
      return null;
    }
  }
  const m = pathname.match(/^\/(secret-intake|connect)\/([^/?#]*)/);
  if (!m) return null;
  const token = m[2];
  if (!sameOrigin && !('ksl_'.startsWith(token) || token.startsWith('ksl_'))) return null;
  return m[1] === 'secret-intake' ? 'secret' : 'connector';
}

/**
 * The href a setup link carries while its URL is still streaming. A fragment,
 * so sanitize and rehype-harden pass it unchanged and it can never navigate.
 */
const PENDING_SETUP_LINK_HREF = '#kortix-setup-link-pending:';

export function pendingSetupLinkHref(kind: SetupLinkKind): string {
  return `${PENDING_SETUP_LINK_HREF}${kind}`;
}

export function parsePendingSetupLinkHref(href?: string): SetupLinkKind | null {
  if (!href?.startsWith(PENDING_SETUP_LINK_HREF)) return null;
  const kind = href.slice(PENDING_SETUP_LINK_HREF.length);
  return kind === 'secret' || kind === 'connector' ? kind : null;
}

/**
 * Streaming text that ends inside a setup link, with that link held as pending.
 *
 * A setup token is several hundred characters, so the link takes a second or
 * two to stream. Until the closing paren arrives, the open link is rewritten
 * to `[label](<pending href>)`: the renderer shows the card it will become,
 * with nothing to click, instead of raw `[label](` text or a card built from a
 * partial token. Every other text passes through unchanged.
 */
export function holdPendingSetupLink(markdown: string): string {
  const open = openMarkdownLinkAtEnd(markdown);
  // A label with brackets inside cannot be re-emitted safely. It keeps the
  // generic streaming-link path.
  if (!open || open.label.includes('[') || open.label.includes(']')) return markdown;
  // `[label](https://…/connect/ksl_…` is arriving, or the label itself is the
  // setup URL: `[https://…/connect/ksl_…`.
  const kind = partialSetupLinkKind(open.destination ?? open.label);
  if (!kind) return markdown;
  // A label that is the URL renders as the card's fallback title, as the
  // finished link would.
  const label = open.destination === null ? '' : open.label;
  return `${markdown.slice(0, open.start)}[${label}](${pendingSetupLinkHref(kind)})`;
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
    // No token while the URL is still streaming, and '' is in every string.
    (token !== '' && text.includes(token)) ||
    text.includes('/secret-intake/') ||
    text.includes('/connect/') ||
    (text.length > 48 && !text.includes(' '));
  return looksLikeUrl ? fallback : text;
}

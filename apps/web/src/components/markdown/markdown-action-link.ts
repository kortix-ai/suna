import { parseSetupLinkHref } from '@/components/setup-links/util';

/**
 * `pending` is a link still streaming in: Streamdown's `remend` closes a
 * partial `[label](…` as `[label](streamdown:incomplete-link)` until the `)`
 * arrives. It renders as a disabled chip so the block does not flip between
 * chips and text on every token.
 */
export type MarkdownActionKind = 'setup' | 'connect' | 'internal' | 'external' | 'pending';
export type MarkdownActionIcon =
  'plug' | 'search' | 'folder' | 'settings' | 'chat' | 'arrow-right' | 'arrow-up-right';

export interface MarkdownActionLink {
  kind: MarkdownActionKind;
  /** As given; the caller resolves proxying. */
  href: string;
  /** Link text with leading/trailing arrow glyphs + whitespace stripped. */
  label: string;
  /** Hostname for absolute URLs, null for root-relative. */
  host: string | null;
  icon: MarkdownActionIcon;
}

/** Hosts an agent mints OAuth/connect links against. Matched exactly or as a subdomain. */
export const KNOWN_CONNECT_HOSTS = [
  'connect.composio.dev',
  'backend.composio.dev',
  'app.composio.dev',
  'pipedream.com',
  'api.pipedream.com',
] as const;

/** The href Streamdown's `remend` gives a link whose `(url)` has not finished streaming. */
export const INCOMPLETE_LINK_HREF = 'streamdown:incomplete-link';

const CONNECT_VERB_PATTERN = /^(connect|reconnect|authorize|authorise)\b/i;
const SEARCH_LABEL_PATTERN = /^search\b/i;

/** Arrow/bullet glyphs agents use to mark up an action link, stripped from the label edges. */
const STRIPPABLE_GLYPHS = new Set([
  '→',
  '➜',
  '➔',
  '➡',
  '⟶',
  '↗',
  '»',
  '>',
  '-',
  '–',
  '—',
  '•',
  '·',
  '*',
  '👉',
]);

function isStrippableChar(char: string): boolean {
  return STRIPPABLE_GLYPHS.has(char) || /\s/u.test(char);
}

/**
 * Removes leading/trailing arrow/bullet glyphs and whitespace (this also
 * removes a leading `->`, since `-` and `>` are each individually
 * strippable), then collapses any remaining internal whitespace to one
 * space.
 */
function stripLabel(raw: string): string {
  const chars = Array.from(raw);
  let start = 0;
  let end = chars.length;
  while (start < end && isStrippableChar(chars[start])) start++;
  while (end > start && isStrippableChar(chars[end - 1])) end--;
  return chars.slice(start, end).join('').replace(/\s+/g, ' ');
}

/** Drops the scheme, a leading `www.`, and a trailing slash — the parts link text omits. */
function normalizeUrlText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/$/, '');
}

/**
 * A link whose visible text is just its own URL is a reference, not an
 * action. `autoLinkUrls` writes `docs.example.com/guide` as the text of
 * `https://docs.example.com/guide`, so both sides are normalized first.
 */
export function isBareUrlLabel(label: string, href: string): boolean {
  return normalizeUrlText(label) === normalizeUrlText(href);
}

function isValidHref(href: string): boolean {
  if (!href || href.startsWith('#')) return false;
  if (/^https?:\/\//i.test(href)) return true;
  // Browsers read `/\host` as `//host`, a protocol-relative off-origin URL.
  return href.startsWith('/') && !href.startsWith('//') && !href.startsWith('/\\');
}

/**
 * The connect card's button text: the label's leading verb when it is a
 * connect verb (`Authorize Linear` → `Authorize`), else `null` so the caller
 * uses its localized default.
 */
export function connectActionVerb(label: string): string | null {
  const verb = CONNECT_VERB_PATTERN.exec(label.trim())?.[1];
  if (!verb) return null;
  return verb.charAt(0).toUpperCase() + verb.slice(1).toLowerCase();
}

function isConnectHost(host: string | null): boolean {
  if (!host) return false;
  return KNOWN_CONNECT_HOSTS.some((known) => host === known || host.endsWith(`.${known}`));
}

function internalIcon(pathname: string, label: string): MarkdownActionIcon {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.some((s) => s === 'connectors' || s === 'integrations' || s === 'connect')) {
    return 'plug';
  }
  if (segments.includes('files')) return 'folder';
  if (segments.includes('settings')) return 'settings';
  if (segments.includes('search') || SEARCH_LABEL_PATTERN.test(label)) return 'search';
  if (segments.some((s) => s === 'sessions' || s === 'chat')) return 'chat';
  return 'arrow-right';
}

/**
 * Classifies one markdown link as an "action" the UI should render as a
 * button/card, or `null` to fall back to plain inline link rendering.
 * `origin` is `window.location.origin`, or `null` on the server.
 */
export function classifyMarkdownActionLink(
  href: string,
  text: string,
  origin: string | null,
): MarkdownActionLink | null {
  // A pending link may have no label yet (`[` just arrived); the caller drops it.
  if (href === INCOMPLETE_LINK_HREF) {
    return { kind: 'pending', href, label: stripLabel(text), host: null, icon: 'arrow-right' };
  }

  if (!isValidHref(href)) return null;

  const label = stripLabel(text);
  if (!label) return null;

  // Setup links (secret-intake / connector) render through SetupLinkButton,
  // which calls parseSetupLinkHref itself for the real decision; this is
  // only used to route the block into that renderer.
  if (parseSetupLinkHref(href)) {
    return { kind: 'setup', href, label, host: computeHost(href), icon: 'plug' };
  }

  if (isBareUrlLabel(label, href)) return null;

  const isRootRelative = href.startsWith('/');
  let parsed: URL | null = null;
  if (!isRootRelative) {
    try {
      parsed = new URL(href);
    } catch {
      return null;
    }
  }
  const host = isRootRelative ? null : parsed!.hostname;

  if (isConnectHost(host) || CONNECT_VERB_PATTERN.test(label)) {
    return { kind: 'connect', href, label, host, icon: 'plug' };
  }

  const isInternal = isRootRelative || (origin !== null && parsed!.origin === origin);
  if (isInternal) {
    const pathname = isRootRelative ? href.split(/[?#]/)[0] : parsed!.pathname;
    return { kind: 'internal', href, label, host, icon: internalIcon(pathname, label) };
  }

  return {
    kind: 'external',
    href,
    label,
    host,
    icon: SEARCH_LABEL_PATTERN.test(label) ? 'search' : 'arrow-up-right',
  };
}

function computeHost(href: string): string | null {
  if (href.startsWith('/')) return null;
  try {
    return new URL(href).hostname;
  } catch {
    return null;
  }
}

/** Glyphs/whitespace only — the same set `stripLabel` trims, as a whole-string test. */
const GLYPH_ONLY_TEXT = /^[\s→➜➔➡⟶↗»>\-–—•·*👉]*$/u;

interface HastLikeNode {
  type?: unknown;
  value?: unknown;
  tagName?: unknown;
  properties?: Record<string, unknown>;
  children?: unknown;
}

function asHastLikeNode(value: unknown): HastLikeNode | null {
  return value !== null && typeof value === 'object' ? (value as HastLikeNode) : null;
}

function collectText(node: unknown): string {
  const n = asHastLikeNode(node);
  if (!n) return '';
  if (n.type === 'text') return typeof n.value === 'string' ? n.value : '';
  if (Array.isArray(n.children)) return n.children.map(collectText).join('');
  return '';
}

/**
 * Walks the children of a hast `p`/`h1`–`h6` node. Returns its links only
 * when every other child is a glyph/whitespace text node or a `br`; returns
 * `null` the moment any real prose, another element, or an empty result
 * shows up.
 */
function scanChildren(children: unknown[]): Array<{ href: string; text: string }> | null {
  const links: Array<{ href: string; text: string }> = [];
  for (const child of children) {
    const c = asHastLikeNode(child);
    if (!c) return null;

    if (c.type === 'text') {
      if (typeof c.value !== 'string' || !GLYPH_ONLY_TEXT.test(c.value)) return null;
      continue;
    }

    if (c.type !== 'element') return null;

    if (c.tagName === 'br') continue;

    if (c.tagName === 'a') {
      links.push({ href: String(c.properties?.href ?? ''), text: collectText(c) });
      continue;
    }

    if (c.tagName === 'strong' || c.tagName === 'em') {
      const nested = scanChildren(Array.isArray(c.children) ? c.children : []);
      if (!nested || nested.length !== 1) return null;
      links.push(nested[0]);
      continue;
    }

    return null;
  }
  return links;
}

/**
 * Given a hast element (`p` or `h1`–`h6`), returns its links when the block
 * is only links plus arrow glyphs/whitespace; otherwise `null`. `node` is
 * typed `unknown` because Streamdown/react-markdown hand the renderer a hast
 * node whose exact shape isn't part of our contract.
 */
export function standaloneActionLinks(node: unknown): Array<{ href: string; text: string }> | null {
  const n = asHastLikeNode(node);
  if (!n || !Array.isArray(n.children)) return null;
  const links = scanChildren(n.children);
  if (!links || links.length === 0) return null;
  return links;
}

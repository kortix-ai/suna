/**
 * URL selection — the page-budget policy.
 *
 * Discovery hands over every same-origin link it saw; extraction can only
 * afford ~40 pages. This module decides which ones are worth the tokens:
 * canonicalize (so `/about`, `/about/` and `/about?utm_source=x` are one page),
 * drop paths that never carry company signal, then rank what remains so the
 * budget is spent on the pages a human would read to describe the company.
 */

export type UrlTier = 'priority' | 'blog' | 'other';

export interface RankedUrl {
  url: string;
  tier: UrlTier;
  score: number;
}

export const MAX_SELECTED_URLS = 40;

// Campaign/click-id noise: identical content, different query string. Stripped
// so the same page discovered from two links dedupes to one fetch.
const TRACKING_PARAMS = new Set([
  'gclid',
  'fbclid',
  'msclkid',
  'igshid',
  'mc_cid',
  'mc_eid',
  'yclid',
  'twclid',
  '_hsenc',
  '_hsmi',
]);

const ASSET_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp', '.avif', '.ico', '.bmp',
  '.css', '.js', '.mjs', '.map', '.json', '.xml', '.txt',
  '.pdf', '.zip', '.gz', '.tar', '.dmg', '.exe', '.pkg',
  '.mp4', '.webm', '.mov', '.mp3', '.wav',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
]);

// Path segments whose pages either repeat content already captured elsewhere
// (archives, pagination) or carry no company signal (auth, cart, boilerplate
// legal, deep docs trees that would eat the whole budget).
const EXCLUDED_SEGMENTS = new Set([
  'wp-content', 'wp-includes', 'wp-json', 'wp-admin',
  'static', 'assets', 'dist', 'build', 'cdn-cgi', 'node_modules',
  'tag', 'tags', 'category', 'categories', 'author', 'archive', 'archives',
  'docs', 'doc', 'documentation', 'api', 'apidocs', 'reference', 'changelog',
  'login', 'signin', 'sign-in', 'signup', 'sign-up', 'register', 'logout',
  'account', 'dashboard', 'admin', 'app',
  'privacy', 'terms', 'legal', 'cookie', 'cookies', 'gdpr', 'dpa', 'imprint',
  'cart', 'checkout', 'basket', 'search', 'feed', 'rss', 'amp',
]);

// Ordered most- to least-valuable. First match wins, so `/about-us` scores as
// `about` rather than falling through to the generic bucket.
const PRIORITY_RULES: Array<{ pattern: RegExp; score: number }> = [
  { pattern: /^\/about/, score: 90 },
  { pattern: /^\/team/, score: 88 },
  { pattern: /^\/(company|who-we-are)/, score: 86 },
  { pattern: /^\/(people|leadership|founders)/, score: 85 },
  { pattern: /^\/pricing/, score: 84 },
  { pattern: /^\/(product|products|platform|solutions)/, score: 82 },
  { pattern: /^\/features/, score: 80 },
  { pattern: /^\/(contact|contact-us)/, score: 78 },
  { pattern: /^\/(customers|case-studies|use-cases)/, score: 70 },
  { pattern: /^\/(careers|jobs)/, score: 60 },
];

const HOMEPAGE_SCORE = 100;
const BLOG_SCORE = 40;
const OTHER_SCORE = 10;

function hasAssetExtension(pathname: string): boolean {
  const lastSegment = pathname.split('/').pop() ?? '';
  const dot = lastSegment.lastIndexOf('.');
  if (dot <= 0) return false;
  return ASSET_EXTENSIONS.has(lastSegment.slice(dot).toLowerCase());
}

/**
 * Canonicalize a URL for identity purposes: lowercase host, no fragment, no
 * tracking params, no trailing slash (except root), sorted remaining query.
 * Returns null when the input is unparseable or not http(s).
 */
export function normalizeUrl(rawUrl: string, base?: string): string | null {
  let parsed: URL;
  try {
    parsed = base ? new URL(rawUrl, base) : new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;

  parsed.hash = '';
  parsed.hostname = parsed.hostname.toLowerCase();

  for (const key of [...parsed.searchParams.keys()]) {
    if (key.toLowerCase().startsWith('utm_') || TRACKING_PARAMS.has(key.toLowerCase())) {
      parsed.searchParams.delete(key);
    }
  }
  // Sorted so two links with the same params in different orders are one page.
  parsed.searchParams.sort();

  if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  }
  return parsed.toString();
}

/** True when the URL's own host matches the crawl origin's host. */
export function isSameOrigin(url: string, origin: string): boolean {
  try {
    const a = new URL(url);
    const b = new URL(origin);
    // `www.` is stripped during domain normalization, so treat it as the same
    // site here too rather than losing every link on a www-canonical site.
    const strip = (h: string) => h.toLowerCase().replace(/^www\./, '');
    return strip(a.hostname) === strip(b.hostname);
  } catch {
    return false;
  }
}

export function isExcluded(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }
  const pathname = parsed.pathname.toLowerCase();
  if (hasAssetExtension(pathname)) return true;

  const segments = pathname.split('/').filter(Boolean);
  for (let i = 0; i < segments.length; i += 1) {
    if (EXCLUDED_SEGMENTS.has(segments[i])) return true;
    // `/page/2`, `/blog/page/3` — pagination repeats content already indexed.
    if (segments[i] === 'page' && /^\d+$/.test(segments[i + 1] ?? '')) return true;
  }
  return false;
}

export function classifyUrl(url: string): { tier: UrlTier; score: number } {
  let pathname: string;
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    return { tier: 'other', score: OTHER_SCORE };
  }
  if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.replace(/\/+$/, '');
  if (pathname === '' || pathname === '/') return { tier: 'priority', score: HOMEPAGE_SCORE };

  for (const rule of PRIORITY_RULES) {
    if (rule.pattern.test(pathname)) return { tier: 'priority', score: rule.score };
  }
  // Blog posts are indexed by title + URL only, so they are worth keeping but
  // never worth full page content.
  if (/^\/(blog|news|posts?|insights|articles)/.test(pathname)) {
    // Shallower blog URLs (the listing) rank above individual posts.
    const depth = pathname.split('/').filter(Boolean).length;
    return { tier: 'blog', score: BLOG_SCORE - Math.min(depth, 5) };
  }
  return { tier: 'other', score: OTHER_SCORE };
}

/**
 * Full selection pass: canonicalize, keep same-origin non-excluded pages,
 * dedupe, rank, and cap. The homepage is always included when present so a
 * profile never loses its most reliable page to the cap.
 */
export function selectUrls(
  rawUrls: string[],
  origin: string,
  limit = MAX_SELECTED_URLS,
): RankedUrl[] {
  const seen = new Map<string, RankedUrl>();

  for (const raw of rawUrls) {
    const normalized = normalizeUrl(raw, origin);
    if (!normalized) continue;
    if (!isSameOrigin(normalized, origin)) continue;
    if (isExcluded(normalized)) continue;
    if (seen.has(normalized)) continue;
    const { tier, score } = classifyUrl(normalized);
    seen.set(normalized, { url: normalized, tier, score });
  }

  return [...seen.values()]
    .sort((a, b) => (b.score - a.score) || a.url.localeCompare(b.url))
    .slice(0, Math.max(0, limit));
}

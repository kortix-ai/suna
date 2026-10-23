/**
 * The title, site name and icon of a channel link (`project_space_links`),
 * fetched by the server in the background (job `link-unfurl`), never in the
 * request that shared the link.
 *
 * The URL comes from a person's message, so every fetch goes through
 * `safeEgressFetch`: private, loopback, link-local and metadata addresses are
 * refused after DNS resolution, the connect is pinned to the checked address,
 * and each redirect is checked again. No cookies or credentials are sent.
 * Limits: GET, 5 s for the whole fetch and read, at most 3 redirects, at most
 * 256 KB read, `text/html` only. Only `<title>`, `og:title`, `og:site_name`
 * and the icon `<link>` are read. The icon is stored as a URL, only when it
 * passes the same address check; the API never fetches or proxies it.
 */
import { projectSpaceLinks } from '@kortix/db';
import { and, eq, gt, ne } from 'drizzle-orm';
import { logger } from '../../lib/logger';
import { db } from '../../shared/db';
import { enqueueJobs, registerJobHandler } from '../../shared/job-queue';
import { assertSafeEgressUrl, safeEgressFetch, UnsafeEgressError } from '../../shared/ssrf-guard';

export const LINK_UNFURL_QUEUE = 'link-unfurl';
export const UNFURL_TIMEOUT_MS = 5_000;
export const UNFURL_MAX_BYTES = 256 * 1024;
const UNFURL_MAX_REDIRECTS = 3;
/** A fetched link is fetched again after this long. */
const FRESH_MS = 7 * 24 * 60 * 60_000;
/** A failed fetch is not tried again before this long. */
const FAILED_BACKOFF_MS = 24 * 60 * 60_000;
const USER_AGENT = 'KortixLinkPreview/1.0 (+https://kortix.com)';
const TITLE_MAX = 200;
const SITE_MAX = 100;
const URL_MAX = 2048;

export type LinkMeta = { title: string | null; siteName: string | null; iconUrl: string | null };

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Control, bidi, zero-width and BOM characters, and lone surrogates: never stored. */
const INVISIBLE = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
/** Anything shaped like an HTML tag, after decoding. `1 < 2` and `<2026>` are not tags. */
const TAG_LIKE = /<\/?[a-z!?][^<>]*>/gi;

/**
 * Plain text from page text: entities decoded (the common named ones and every
 * numeric one), then tag-shaped text, control, bidi and zero-width characters
 * removed, whitespace collapsed, capped. The result is untrusted outside text:
 * a consumer that is not React escaping must still escape it, and an agent
 * prompt must frame it as outside content.
 */
function cleanText(raw: string, max: number): string | null {
  const text = raw
    .replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,6});/gi, (whole, name: string) => {
      if (name[0] !== '#') return ENTITIES[name.toLowerCase()] ?? whole;
      const code = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    })
    .replace(/\s+/g, ' ')
    .replace(INVISIBLE, '')
    .replace(TAG_LIKE, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.slice(0, max) : null;
}

/**
 * Page fetches stay on the default ports (80, 443) and never go from https
 * to http on a redirect.
 */
function checkPageUrl(url: URL, from: URL | null): void {
  if (url.port !== '') throw new UnsafeEgressError('only ports 80 and 443', url.href);
  if (from?.protocol === 'https:' && url.protocol === 'http:') throw new UnsafeEgressError('https to http redirect', url.href);
}

/** The attributes of one tag, names lowercased. */
function attributes(tag: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const m of tag.matchAll(/([a-z_:][-a-z0-9_:.]{0,63})\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) {
    const name = m[1]!.toLowerCase();
    if (!attrs.has(name)) attrs.set(name, m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

/** An http(s) URL of `href` against `base`, or null. */
function absoluteHttpUrl(href: string, base: string): string | null {
  try {
    const url = new URL(href.trim(), base);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null;
    return url.href.length <= URL_MAX ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Read the title, site name and icon from the start of an HTML page. `og:title`
 * wins over `<title>`; `rel="icon"` wins over `apple-touch-icon`. The icon is
 * resolved against `baseUrl`; a non-http(s) icon is dropped. A tag's
 * attributes are read only up to 1,024 characters and a name only up to 64,
 * so a crafted page costs at most a constant per character.
 */
export function parseLinkMeta(html: string, baseUrl: string): LinkMeta {
  // Only the head carries these tags; the rest is not scanned.
  const headEnd = html.search(/<\/head\s*>|<body[\s>]/i);
  const head = headEnd === -1 ? html : html.slice(0, headEnd);
  let title: string | null = null;
  let ogTitle: string | null = null;
  let siteName: string | null = null;
  let icon: string | null = null;
  let touchIcon: string | null = null;
  for (const m of head.matchAll(/<(title|meta|link)\b([^<>]{0,1024})>/gi)) {
    const name = m[1]!.toLowerCase();
    if (name === 'title') {
      if (title !== null) continue;
      const start = m.index! + m[0].length;
      const end = head.slice(start).search(/<\/title\s*>/i);
      title = cleanText(end === -1 ? '' : head.slice(start, start + end), TITLE_MAX) ?? '';
      continue;
    }
    const attrs = attributes(m[2]!);
    if (name === 'meta') {
      const key = (attrs.get('property') ?? attrs.get('name') ?? '').toLowerCase();
      const content = attrs.get('content');
      if (content === undefined) continue;
      if (key === 'og:title' && ogTitle === null) ogTitle = cleanText(content, TITLE_MAX);
      else if (key === 'og:site_name' && siteName === null) siteName = cleanText(content, SITE_MAX);
      continue;
    }
    const rel = (attrs.get('rel') ?? '').toLowerCase().split(/\s+/);
    const href = attrs.get('href');
    if (!href) continue;
    if (rel.includes('icon') && icon === null) icon = absoluteHttpUrl(href, baseUrl);
    else if (rel.includes('apple-touch-icon') && touchIcon === null) touchIcon = absoluteHttpUrl(href, baseUrl);
  }
  return { title: ogTitle || title || null, siteName, iconUrl: icon ?? touchIcon };
}

/** At most `max` bytes of the body, then the stream is cancelled. */
async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < max) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(Math.min(size, max));
  let at = 0;
  for (const chunk of chunks) {
    const part = chunk.subarray(0, out.length - at);
    out.set(part, at);
    at += part.length;
    if (at === out.length) break;
  }
  return out;
}

/**
 * Fetch one link's page and read its title, site name and icon. Throws on a
 * refused address, a timeout, too many redirects or a non-2xx answer. A page
 * that is not HTML answers no title (its body is not read).
 */
export async function fetchLinkMeta(
  url: string,
  deps: { fetch?: typeof safeEgressFetch; timeoutMs?: number } = {},
): Promise<LinkMeta> {
  const controller = new AbortController();
  // One deadline for the redirects and the body read: a slow body cannot hold the job.
  const timer = setTimeout(
    () => controller.abort(new DOMException('link fetch timed out', 'TimeoutError')),
    deps.timeoutMs ?? UNFURL_TIMEOUT_MS,
  );
  try {
    const deadline = new Promise<never>((_, reject) =>
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }),
    );
    const work = async (): Promise<LinkMeta> => {
      const res = await (deps.fetch ?? safeEgressFetch)(url, {
        method: 'GET',
        allowHttp: true,
        maxRedirects: UNFURL_MAX_REDIRECTS,
        checkUrl: checkPageUrl,
        signal: controller.signal,
        credentials: 'omit',
        headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml;q=0.9' },
      });
      if (res.status < 200 || res.status >= 300) {
        await res.body?.cancel().catch(() => {});
        throw new Error(`status ${res.status}`);
      }
      const type = (res.headers.get('content-type') ?? '').toLowerCase();
      if (!type.includes('text/html') && !type.includes('application/xhtml+xml')) {
        await res.body?.cancel().catch(() => {});
        return { title: null, siteName: null, iconUrl: null };
      }
      const html = new TextDecoder().decode(await readCapped(res, UNFURL_MAX_BYTES));
      const meta = parseLinkMeta(html, url);
      if (meta.iconUrl) {
        // The icon is stored only when it is https on 443 and its host passes the same address check.
        const icon = new URL(meta.iconUrl);
        meta.iconUrl =
          icon.protocol === 'https:' && icon.port === ''
            ? await assertSafeEgressUrl(meta.iconUrl).then(
                () => meta.iconUrl,
                () => null,
              )
            : null;
      }
      return meta;
    };
    return await Promise.race([work(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

type UnfurlState = { linkId: string; fetchedAt: Date | null; fetchFailedAt: Date | null };

/** The link has no fresh fetch and no failure in the last 24 h. */
export function needsUnfurl(row: Omit<UnfurlState, 'linkId'>, now = Date.now()): boolean {
  if (row.fetchedAt && now - row.fetchedAt.getTime() < FRESH_MS) return false;
  if (row.fetchFailedAt && now - row.fetchFailedAt.getTime() < FAILED_BACKOFF_MS) return false;
  return true;
}

/**
 * Queue a fetch for each link that needs one. One job per link per UTC day:
 * a link shared many times in a day is fetched once. Never throws: a link
 * without a title is still a link.
 */
export async function enqueueLinkUnfurls(rows: UnfurlState[]): Promise<void> {
  const day = Math.floor(Date.now() / (24 * 60 * 60_000));
  const jobs = rows.filter((row) => needsUnfurl(row)).map((row) => ({ key: `${row.linkId}:${day}`, payload: { link_id: row.linkId } }));
  await enqueueJobs(LINK_UNFURL_QUEUE, jobs).catch((err) =>
    logger.warn('[spaces] queueing link unfurls failed', { error: err instanceof Error ? err.message : String(err) }),
  );
}

/**
 * The `link-unfurl` job. Another channel of the same project that fetched the
 * same URL within 7 days lends its values; else the page is fetched. A failure
 * records `fetch_failed_at` and is not retried by the queue (the next share
 * after 24 h queues it again).
 */
export async function unfurlLink(linkId: string): Promise<void> {
  try {
    await unfurlLinkUnsafe(linkId);
  } catch {
    // A database error message carries the query parameters, the URL among
    // them: the queue logs and stores only this, and retries with backoff.
    throw new Error('link unfurl: database error');
  }
}

async function unfurlLinkUnsafe(linkId: string): Promise<void> {
  const t = projectSpaceLinks;
  const [row] = await db
    .select({ projectId: t.projectId, url: t.url, fetchedAt: t.fetchedAt, fetchFailedAt: t.fetchFailedAt })
    .from(t)
    .where(eq(t.linkId, linkId))
    .limit(1);
  if (!row || !needsUnfurl(row)) return;
  // ponytail: reuse within one project only (served by the project_id index); a url index if cross-project reuse matters.
  const [cached] = await db
    .select({ fetchedTitle: t.fetchedTitle, siteName: t.siteName, iconUrl: t.iconUrl, fetchedAt: t.fetchedAt })
    .from(t)
    .where(
      and(eq(t.projectId, row.projectId), eq(t.url, row.url), ne(t.linkId, linkId), gt(t.fetchedAt, new Date(Date.now() - FRESH_MS))),
    )
    .limit(1);
  if (cached) {
    await db.update(t).set({ ...cached, fetchFailedAt: null }).where(eq(t.linkId, linkId));
    return;
  }
  try {
    const meta = await fetchLinkMeta(row.url);
    await db
      .update(t)
      .set({ fetchedTitle: meta.title, siteName: meta.siteName, iconUrl: meta.iconUrl, fetchedAt: new Date(), fetchFailedAt: null })
      .where(eq(t.linkId, linkId));
  } catch (err) {
    // Neither the URL nor its host is logged: they come from a person's message.
    const reason = err instanceof UnsafeEgressError ? 'unsafe_egress' : err instanceof Error ? err.name : 'error';
    logger.info('[spaces] link unfurl failed', { linkId, reason });
    await db.update(t).set({ fetchFailedAt: new Date() }).where(eq(t.linkId, linkId));
  }
}

registerJobHandler(LINK_UNFURL_QUEUE, (job) => unfurlLink(String(job.payload.link_id ?? '')), 60_000);

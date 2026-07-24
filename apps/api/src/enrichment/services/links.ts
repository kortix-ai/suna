/**
 * Outbound link harvesting.
 *
 * Discovery's crawl deliberately keeps only same-origin links — that is the
 * right policy for deciding which pages to fetch, but it means every link a
 * site points *away* from itself (its X/GitHub/LinkedIn/Peerlist profile, a
 * mailto, a partner site) was silently dropped before extraction ever saw it.
 * A personal portfolio's whole point is often those outbound links, so this
 * module walks the same `a[href]` set discovery already parses, classifies
 * what it finds, and returns it as data — the profile no longer depends on
 * the model happening to notice a link buried in a page's prose or footer.
 */
import * as cheerio from 'cheerio';
import { isSameOrigin, normalizeUrl } from './url-filter';

export interface SocialLink {
  platform: string;
  url: string;
}

export interface LinkHarvest {
  socials: SocialLink[];
  emails: string[];
  phones: string[];
  otherExternal: string[];
}

/** Keeps a page with a long partner/press list from crowding out the rest of the profile. */
export const MAX_OTHER_EXTERNAL = 50;

const ASSET_EXTENSION_RE =
  /\.(jpe?g|png|gif|svg|webp|avif|ico|bmp|css|m?js|map|json|xml|txt|pdf|zip|gz|tar|dmg|exe|pkg|mp4|webm|mov|mp3|wav|woff2?|ttf|eot|otf)$/i;

interface PlatformRule {
  hosts: string[];
  platform: string;
}

// Ordered as given in the spec; lookup is by exact host or subdomain, so
// e.g. `gist.github.com` still counts as `github`.
const PLATFORM_RULES: PlatformRule[] = [
  { hosts: ['x.com', 'twitter.com'], platform: 'x' },
  { hosts: ['github.com'], platform: 'github' },
  { hosts: ['linkedin.com'], platform: 'linkedin' },
  { hosts: ['peerlist.io'], platform: 'peerlist' },
  { hosts: ['youtube.com'], platform: 'youtube' },
  { hosts: ['instagram.com'], platform: 'instagram' },
  { hosts: ['dribbble.com'], platform: 'dribbble' },
  { hosts: ['behance.net'], platform: 'behance' },
  { hosts: ['bsky.app'], platform: 'bluesky' },
  { hosts: ['npmjs.com'], platform: 'npm' },
  { hosts: ['crunchbase.com'], platform: 'crunchbase' },
  { hosts: ['producthunt.com'], platform: 'producthunt' },
  { hosts: ['discord.gg', 'discord.com'], platform: 'discord' },
  { hosts: ['t.me'], platform: 'telegram' },
  { hosts: ['medium.com'], platform: 'medium' },
  { hosts: ['substack.com'], platform: 'substack' },
  { hosts: ['stackoverflow.com'], platform: 'stackoverflow' },
  { hosts: ['gitlab.com'], platform: 'gitlab' },
];

function bareHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, '');
}

/**
 * Mastodon has no single domain — anyone can run an instance — so unlike the
 * rest of the table this is a substring match on the host rather than a fixed
 * list.
 */
function classifyHost(host: string): string | null {
  const bare = bareHost(host);
  for (const rule of PLATFORM_RULES) {
    if (rule.hosts.some((h) => bare === h || bare.endsWith(`.${h}`))) return rule.platform;
  }
  if (bare.includes('mastodon')) return 'mastodon';
  return null;
}

function isAssetPath(pathname: string): boolean {
  return ASSET_EXTENSION_RE.test(pathname);
}

function decodeAfterScheme(href: string, scheme: string): string | null {
  const raw = href.slice(scheme.length).split('?')[0]?.trim();
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Harvest one page's outbound links. Never throws: unparseable markup or a
 * junk href just means that link (or the whole page) contributes nothing,
 * the same tolerance `extractSignals`/`extractLinks` already apply.
 */
export function harvestLinks(html: string, pageUrl: string): LinkHarvest {
  const result: LinkHarvest = { socials: [], emails: [], phones: [], otherExternal: [] };

  let $: cheerio.CheerioAPI;
  try {
    $ = cheerio.load(html);
  } catch {
    return result;
  }

  const seenPlatforms = new Set<string>();
  const seenEmails = new Set<string>();
  const seenPhones = new Set<string>();
  const seenExternal = new Set<string>();

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href')?.trim();
    if (!href) return;

    if (/^mailto:/i.test(href)) {
      const email = decodeAfterScheme(href, 'mailto:')?.toLowerCase() ?? null;
      if (email && !seenEmails.has(email)) {
        seenEmails.add(email);
        result.emails.push(email);
      }
      return;
    }

    if (/^tel:/i.test(href)) {
      const phone = decodeAfterScheme(href, 'tel:');
      if (phone && !seenPhones.has(phone)) {
        seenPhones.add(phone);
        result.phones.push(phone);
      }
      return;
    }

    const normalized = normalizeUrl(href, pageUrl);
    if (!normalized) return;
    if (isSameOrigin(normalized, pageUrl)) return;

    let pathname: string;
    try {
      pathname = new URL(normalized).pathname;
    } catch {
      return;
    }
    if (isAssetPath(pathname)) return;

    const platform = classifyHost(new URL(normalized).hostname);
    if (platform) {
      if (!seenPlatforms.has(platform)) {
        seenPlatforms.add(platform);
        result.socials.push({ platform, url: normalized });
      }
      return;
    }

    if (result.otherExternal.length >= MAX_OTHER_EXTERNAL) return;
    if (!seenExternal.has(normalized)) {
      seenExternal.add(normalized);
      result.otherExternal.push(normalized);
    }
  });

  return result;
}

/**
 * Fold one page's harvest into an accumulator across the whole crawl. Socials
 * keep one entry per platform — first page to link it wins, mirroring how
 * `mergeSignals` treats OpenGraph/meta as the site's earliest, most homepage-
 * adjacent claim about itself. Emails/phones/other-external have no natural
 * key, so they are unioned and deduped instead, with other-external held to
 * the same cap per merge as within a single page.
 */
export function mergeLinkHarvest(into: LinkHarvest, from: LinkHarvest): void {
  const platforms = new Set(into.socials.map((s) => s.platform));
  for (const social of from.socials) {
    if (platforms.has(social.platform)) continue;
    platforms.add(social.platform);
    into.socials.push(social);
  }

  const emails = new Set(into.emails);
  for (const email of from.emails) {
    if (emails.has(email)) continue;
    emails.add(email);
    into.emails.push(email);
  }

  const phones = new Set(into.phones);
  for (const phone of from.phones) {
    if (phones.has(phone)) continue;
    phones.add(phone);
    into.phones.push(phone);
  }

  const external = new Set(into.otherExternal);
  for (const url of from.otherExternal) {
    if (into.otherExternal.length >= MAX_OTHER_EXTERNAL) break;
    if (external.has(url)) continue;
    external.add(url);
    into.otherExternal.push(url);
  }
}

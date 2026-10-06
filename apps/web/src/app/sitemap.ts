import type { MetadataRoute } from 'next';

import { ROLES } from '@/features/marketing/solutions/registry';

import { locales } from '@/i18n/config';
import {
  absoluteUrl,
  areUseCasesPublic,
  getPublicContentRecords,
  STATIC_PUBLIC_ROUTES,
} from '@/lib/seo/public-content';

type SitemapEntry = MetadataRoute.Sitemap[number];

// The middleware's locale matcher is a prefix match on MARKETING_ROUTES, so
// /de/support already rewrites and self-canonicalizes. Listing a route here is
// what puts its per-locale URLs and hreflang set in the sitemap. Every route
// below renders fully translated (the strict i18n audit covers its copy), and
// its layout emits the same hreflang set through localizedMarketingMetadata.
// The docs tree, use cases, the changelog and the marketplace have English
// bodies, so they stay English-only.
export const LOCALIZED_ROUTES = [
  '/',
  '/about',
  '/agent-computer',
  '/agents-and-skills',
  '/automations',
  '/careers',
  '/channels',
  '/company-as-code',
  '/connectors',
  '/contact',
  '/developers',
  '/download',
  '/enterprise',
  '/legal',
  '/pricing',
  '/security',
  '/self-hosted',
  '/solutions',
  '/support',
] as const;

function htmlEntry(pathname: string, lastModified?: string): SitemapEntry {
  return {
    url: absoluteUrl(pathname),
    ...(lastModified ? { lastModified } : {}),
    changeFrequency: 'weekly',
    priority: pathname === '/' ? 1 : pathname === '/docs' ? 0.9 : 0.7,
  };
}

function markdownEntry(pathname: string, lastModified?: string): SitemapEntry {
  return {
    url: absoluteUrl(pathname),
    ...(lastModified ? { lastModified } : {}),
    changeFrequency: 'weekly',
    priority: 0.5,
  };
}

export default function sitemap(): MetadataRoute.Sitemap {
  const includeUseCases = areUseCasesPublic();
  const records = getPublicContentRecords({ includeUseCases });
  const entries = new Map<string, SitemapEntry>();

  for (const pathname of STATIC_PUBLIC_ROUTES) {
    if (pathname === '/use-cases' && !includeUseCases) continue;
    const entry = htmlEntry(pathname);
    entries.set(entry.url, entry);
  }

  // Keep the explicit locale routes that middleware actually serves. English
  // uses the unprefixed URL; every alternate stays on the same non-www origin.
  for (const pathname of [...LOCALIZED_ROUTES, ...ROLES.map((role) => `/solutions/${role.slug}`)]) {
    const languages = Object.fromEntries(
      locales.map((locale) => [
        locale,
        absoluteUrl(locale === 'en' ? pathname : `/${locale}${pathname === '/' ? '' : pathname}`),
      ]),
    );
    languages['x-default'] = absoluteUrl(pathname);
    for (const locale of locales) {
      const localizedPath =
        locale === 'en' ? pathname : `/${locale}${pathname === '/' ? '' : pathname}`;
      const entry = htmlEntry(localizedPath);
      entry.alternates = { languages };
      entries.set(entry.url, entry);
    }
  }

  for (const record of records) {
    if (record.htmlPath === '/use-cases' && !includeUseCases) continue;
    const html = htmlEntry(record.htmlPath, record.lastModified);
    // Keep the hreflang set a localized route already carries.
    const prior = entries.get(html.url);
    entries.set(html.url, prior?.alternates ? { ...html, alternates: prior.alternates } : html);
    if (record.markdownPath) {
      const markdown = markdownEntry(record.markdownPath, record.lastModified);
      entries.set(markdown.url, markdown);
    }
  }

  for (const pathname of ['/llms.txt', '/llms-full.txt']) {
    const entry = markdownEntry(pathname);
    entries.set(entry.url, entry);
  }

  return [...entries.values()].sort((a, b) => a.url.localeCompare(b.url));
}

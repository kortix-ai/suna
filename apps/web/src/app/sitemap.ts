import type { MetadataRoute } from 'next';

import { locales } from '@/i18n/config';
import {
  absoluteUrl,
  areUseCasesPublic,
  getPublicContentRecords,
  STATIC_PUBLIC_ROUTES,
} from '@/lib/seo/public-content';

type SitemapEntry = MetadataRoute.Sitemap[number];

const LOCALIZED_ROUTES = ['/', '/legal', '/support'] as const;

function htmlEntry(pathname: string, lastModified?: string): SitemapEntry {
  return {
    url: absoluteUrl(pathname),
    ...(lastModified ? { lastModified } : {}),
    changeFrequency: pathname.startsWith('/blog/') ? 'monthly' : 'weekly',
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
  for (const pathname of LOCALIZED_ROUTES) {
    const languages = Object.fromEntries(
      locales.map((locale) => [
        locale,
        absoluteUrl(locale === 'en' ? pathname : `/${locale}${pathname === '/' ? '' : pathname}`),
      ]),
    );
    for (const locale of locales) {
      const localizedPath =
        locale === 'en' ? pathname : `/${locale}${pathname === '/' ? '' : pathname}`;
      const entry = htmlEntry(localizedPath);
      entry.alternates = { languages };
      entries.set(entry.url, entry);
    }
  }

  for (const record of records) {
    const html = htmlEntry(record.htmlPath, record.lastModified);
    entries.set(html.url, html);
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

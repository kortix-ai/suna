import type { Metadata } from 'next';
import { headers } from 'next/headers';

import { defaultLocale, locales, type Locale } from '@/i18n/config';
import { getMarketingRecord } from '@/lib/seo/public-content';
import { CANONICAL_ORIGIN, siteMetadata } from '@/lib/site-metadata';

export const DEFAULT_OG_IMAGE = {
  url: '/banner.png',
  width: 1200,
  height: 630,
  alt: siteMetadata.title,
} as const;

// Next.js replaces (not deep-merges) the parent `openGraph`/`twitter` objects
// when a page defines its own, so every page-level metadata object must carry
// the full social card — images included — or the root banner is lost.
export function socialMetadata(title: string, description: string | undefined, url: string) {
  return {
    openGraph: {
      title,
      description,
      url,
      siteName: siteMetadata.name,
      type: 'website',
      locale: 'en_US',
      images: [DEFAULT_OG_IMAGE],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      site: '@kortix',
      creator: '@kortix',
      images: [DEFAULT_OG_IMAGE.url],
    },
  } satisfies Pick<Metadata, 'openGraph' | 'twitter'>;
}

export function marketingMetadata(pathname: string): Metadata {
  const record = getMarketingRecord(pathname);
  if (!record) throw new Error(`Missing marketing SEO record for ${pathname}`);
  const url = `${CANONICAL_ORIGIN}${pathname}`;
  return {
    title: record.title,
    description: record.description,
    alternates: { canonical: url },
    ...socialMetadata(record.title, record.description, url),
  };
}

export function localePath(locale: Locale, pathname: string): string {
  if (locale === defaultLocale) return pathname;
  return `/${locale}${pathname === '/' ? '' : pathname}`;
}

// hreflang map for a locale-routed marketing pathname. `x-default` points at
// the unprefixed English URL, matching the sitemap alternates.
export function languageAlternates(pathname: string): Record<string, string> {
  const languages = Object.fromEntries(
    locales.map((locale) => [locale, `${CANONICAL_ORIGIN}${localePath(locale, pathname)}`]),
  );
  languages['x-default'] = `${CANONICAL_ORIGIN}${localePath(defaultLocale, pathname)}`;
  return languages;
}

// The middleware rewrites /de, /fr, … onto the unprefixed route and records the
// requested locale in the `x-locale` header. Reading it here lets each locale
// variant self-canonicalize to its own URL instead of the English one.
export async function requestLocale(): Promise<Locale> {
  const locale = (await headers()).get('x-locale');
  return locale && locales.includes(locale as Locale) ? (locale as Locale) : defaultLocale;
}

// Metadata for the three locale-routed marketing pages (/, /legal, /support):
// per-locale canonical plus a full hreflang set in the <head>.
export async function localizedMarketingMetadata(pathname: string): Promise<Metadata> {
  const base = marketingMetadata(pathname);
  const locale = await requestLocale();
  const canonical = `${CANONICAL_ORIGIN}${localePath(locale, pathname)}`;
  return {
    ...base,
    // The homepage title is the full brand line; running it through the root
    // `%s | Kortix` template would double the brand. `absolute` also keeps the
    // rendered title distinct from the root-layout default — a resolved title
    // identical to the parent default is dropped from the streamed metadata,
    // leaving the page with no <title> in the served HTML.
    ...(pathname === '/' ? { title: { absolute: siteMetadata.title } } : {}),
    alternates: { canonical, languages: languageAlternates(pathname) },
    openGraph: { ...base.openGraph, url: canonical },
  };
}

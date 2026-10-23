import { getTranslations } from '@/i18n/get-translations';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

/**
 * The catch-all is the one matched route whose destination is the not-found
 * boundary, so it owns the 404 document title for client-side navigations:
 * the App Router applies a route's own metadata to the tab title on a soft
 * navigation, and the not-found boundary itself cannot (the boundary
 * replaces the page segment, so only its own module metadata — see
 * not-found.tsx — and the layouts' survive into a render; neither reaches
 * the flight head of this route).
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('hardcodedUi');
  // A plain string, so the root layout's `title.template` composes the full
  // document title exactly as it does for every other page.
  // `robots` replaces the root layout's `index, follow`: this route renders its
  // own metadata before notFound() adds its `noindex` tag (KRTX-3253).
  return {
    title: t.raw('autoAppNotFoundJsxText404PageNotFoundf7ea8161'),
    robots: { index: false, follow: true },
  };
}

// The root layout lives in app/[locale], so an unmatched path under a locale
// has no parent not-found boundary of its own. This catch-all routes it to
// app/[locale]/not-found.tsx inside the localized root layout.
//
// No path renders the page in a production build: the router answers 404
// before any render. Rendering it threw notFound() inside the I18nProvider
// Suspense boundary, after the shell had flushed, so every unmatched path
// answered 200 with the 404 page (KRTX-3169). `next dev` does not enforce
// `dynamicParams`, so there the page still renders and calls notFound().
export const dynamicParams = false;
export function generateStaticParams(): Array<{ rest: string[] }> {
  return [];
}

export default function CatchAllNotFound(): never {
  notFound();
}

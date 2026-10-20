import type { Metadata } from 'next';

import { getTranslations } from '@/i18n/get-translations';
import { siteMetadata } from '@kortix/ui/internal/lib/site-metadata';

import NotFoundBoundary from './[locale]/not-found';
import './globals.css';

/**
 * The 404 page for URLs that match no route at all — site areas the
 * middleware passes through without a locale rewrite (e.g. /blog, /docs),
 * so an unmatched one never reaches the [locale] tree and its not-found
 * boundary. Next renders this module alone for the `/_not-found` route —
 * no root layout exists above the [locale] segment — so it brings its own
 * document shell (the [locale] boundary renders the same UI inside it).
 *
 * It must own the document title itself: the route metadata of a
 * client-side navigation to an unmatched URL is this module's, and a
 * client-side navigation never re-resolves metadata beyond the route it
 * lands on (that is the stale-title bug this page exists to fix).
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('hardcodedUi');
  return {
    title: `${t.raw('autoAppNotFoundJsxText404PageNotFoundf7ea8161')} | ${siteMetadata.name}`,
  };
}

const NotFound = () => (
  <html lang="en" translate="no" suppressHydrationWarning>
    <body className="notranslate text-foreground bg-background flex min-h-dvh w-full scroll-smooth flex-col font-sans font-medium tracking-normal antialiased">
      <NotFoundBoundary />
    </body>
  </html>
);

export default NotFound;

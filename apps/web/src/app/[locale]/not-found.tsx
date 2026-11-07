import { getTranslations } from '@/i18n/get-translations';
import { useTranslations } from '@/i18n/use-translations';
import { NotFoundState } from '@/components/common/not-found-state';
import type { Metadata } from 'next';

import { NotFoundTitleSync } from './not-found-title-sync';

/**
 * The not-found boundary owns the 404 document title. Next resolves the
 * metadata of a not-found render from the layouts plus THIS module (the
 * error-metadata item, resolve-metadata.js `collectMetadata`), so the title
 * reaches the head on a hard load — the paths a `<title>` rendered inside
 * the component or the throwing page's own metadata both lose (the boundary
 * replaces the page, and React re-asserts the metadata-owned `<title>` after
 * client effects run).
 *
 * On a client-side navigation the title only updates when the flight's head
 * mounts (verified for a route whose own metadata is the catch-all's); when
 * the not-found render replaces an aborted layout no head mounts at all, and
 * NotFoundTitleSync below writes the title instead.
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('hardcodedUi');
  // A plain string, so the root layout's `title.template` composes the full
  // document title exactly as it does for every other page. `robots` replaces
  // the root layout's `index, follow`, which disagreed with the `noindex` tag
  // that notFound() adds (KRTX-3253).
  return {
    title: t.raw('autoAppNotFoundJsxText404PageNotFoundf7ea8161'),
    robots: { index: false, follow: true },
  };
}

const NotFound = () => {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const heading = tI18nHardcoded.raw('autoAppNotFoundJsxText404PageNotFoundf7ea8161');
  return (
    <section>
      {/* Renders null; it only owns the tab title (see the file's comment). */}
      <NotFoundTitleSync heading={heading} />
      <NotFoundState className="h-dvh" />
    </section>
  );
};

export default NotFound;

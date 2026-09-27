import { getTranslations } from '@/i18n/get-translations';
import { localizeUiCatalog } from '@/i18n/localize-ui-catalog';
import { REMAINING_UI_TRANSLATION_KEYS } from '@/i18n/remaining-ui-translation-keys.generated';
import { CANONICAL_ORIGIN } from '@/lib/site-metadata';
import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';

import { ChangelogView } from '@/features/marketing/changelog/changelog-view';
import { changelogPageHref } from '@/features/marketing/changelog/paging';
import { getChangelogPage } from '@/features/marketing/changelog/releases';

type Props = { params: Promise<{ page: string }> };

/** `/changelog/page/2` → 2. Anything that is not a plain positive integer is
 *  not a page (`/changelog/page/02`, `/changelog/page/1.5`). */
function parsePage(raw: string): number | null {
  return /^[1-9]\d*$/.test(raw) ? Number(raw) : null;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const page = parsePage((await params).page);
  const title = page ? `Changelog · Page ${page}` : 'Changelog';
  const url = `${CANONICAL_ORIGIN}${changelogPageHref(page ?? 1)}`;
  const tI18nComplete = await getTranslations('hardcodedUi.i18nComplete');
  const { description, alt } = localizeUiCatalog(
    { description: 'Every Kortix release, straight from the source.', alt: 'Kortix Changelog' },
    tI18nComplete,
    REMAINING_UI_TRANSLATION_KEYS,
  );
  return {
    title,
    description,
    openGraph: {
      title: `Kortix ${title}`,
      description,
      url,
      siteName: 'Kortix',
      type: 'website',
      images: [{ url: '/banner.png', width: 1200, height: 630, alt }],
    },
    alternates: { canonical: url },
  };
}

export const revalidate = 3600;

export default async function ChangelogOlderPage({ params }: Props) {
  const page = parsePage((await params).page);
  if (page === null) notFound();
  // Page 1 has one URL: the bare /changelog.
  if (page === 1) permanentRedirect('/changelog');
  const data = await getChangelogPage(page);
  if (!data) notFound();
  return <ChangelogView data={data} />;
}

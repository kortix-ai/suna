import { localizeUiCatalog } from '@/i18n/localize-ui-catalog';
import { REMAINING_UI_TRANSLATION_KEYS } from '@/i18n/remaining-ui-translation-keys.generated';
import { CANONICAL_ORIGIN } from '@/lib/site-metadata';
import type { Metadata } from 'next';
import { getTranslations } from '@/i18n/get-translations';

import { ChangelogView } from '@/features/marketing/changelog/changelog-view';
import { getChangelogPage } from '@/features/marketing/changelog/releases';

export async function generateMetadata(): Promise<Metadata> {
  const tI18nComplete = await getTranslations('hardcodedUi.i18nComplete');
  return localizeUiCatalog(
    {
      title: 'Changelog',
      description:
        'Every Kortix release, straight from the source. New features, fixes, and improvements — versioned and dated.',
      openGraph: {
        title: 'Kortix Changelog',
        description: 'Every Kortix release, straight from the source.',
        url: `${CANONICAL_ORIGIN}/changelog`,
        siteName: 'Kortix',
        type: 'website' as const,
        images: [{ url: '/banner.png', width: 1200, height: 630, alt: 'Kortix Changelog' }],
      },
      twitter: {
        card: 'summary_large_image' as const,
        title: 'Kortix Changelog',
        description: 'Every Kortix release, straight from the source.',
        images: ['/banner.png'],
      },
      alternates: { canonical: `${CANONICAL_ORIGIN}/changelog` },
    },
    tI18nComplete,
    REMAINING_UI_TRANSLATION_KEYS,
  );
}

// Rebuild hourly so new releases show up without a deploy. The rendered
// release notes carry their own hourly cache (features/marketing/changelog).
export const revalidate = 3600;

export default async function ChangelogPage() {
  // Page 1 always exists: an unreachable GitHub yields an empty page.
  const data = (await getChangelogPage(1))!;
  return <ChangelogView data={data} />;
}

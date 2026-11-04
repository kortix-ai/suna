import { localizeUiCatalog } from '@kortix/ui/i18n';
import { REMAINING_UI_TRANSLATION_KEYS } from '@kortix/ui/i18n/ui-catalog/remaining-ui-translation-keys.generated';
import { CANONICAL_ORIGIN } from '@kortix/ui/internal/lib/site-metadata';
import type { Metadata } from 'next';
import { getTranslations } from '@/i18n/get-translations';

import { getWeeklyChangelog } from '@/features/marketing/changelog/releases';
import { WeeklyView } from '@/features/marketing/changelog/weekly-view';

const DESCRIPTION = 'What shipped in Kortix each week, straight from our production releases.';

export async function generateMetadata(): Promise<Metadata> {
  const tI18nComplete = await getTranslations('hardcodedUi.i18nComplete');
  return localizeUiCatalog(
    {
      title: 'Changelog',
      description: DESCRIPTION,
      openGraph: {
        title: 'Kortix Changelog',
        description: DESCRIPTION,
        url: `${CANONICAL_ORIGIN}/changelog`,
        siteName: 'Kortix',
        type: 'website' as const,
        images: [{ url: '/banner.png', width: 1200, height: 630, alt: 'Kortix Changelog' }],
      },
      twitter: {
        card: 'summary_large_image' as const,
        title: 'Kortix Changelog',
        description: DESCRIPTION,
        images: ['/banner.png'],
      },
      alternates: { canonical: `${CANONICAL_ORIGIN}/changelog` },
    },
    tI18nComplete,
    REMAINING_UI_TRANSLATION_KEYS,
  );
}

// Rebuild hourly so a new release shows up in its week without a deploy.
export const revalidate = 3600;

export default async function ChangelogPage() {
  return <WeeklyView data={await getWeeklyChangelog()} />;
}

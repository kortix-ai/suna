import { CareersPage as CareersPageContent } from '@/features/marketing/careers/careers-page';
import { CANONICAL_ORIGIN } from '@/lib/site-metadata';
import type { Metadata } from 'next';
import { getTranslations } from '@/i18n/get-translations';

const DESCRIPTION =
  'Open positions at Kortix — Marketing / Content, Sales, FDE / Services, Product / Eng, Product / R&D. Belgrade, Serbia and San Francisco. We hire for prolonged ownership.';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('hardcodedUi.i18nComplete');
  const title = t.raw('text7e658675b5ca');
  const socialTitle = t.raw('text47f57c0ab829');
  const description = t.raw('text0f4827ef74ea');
  return {
    title,
    description,
    keywords:
      'Kortix careers, Kortix jobs, AI startup jobs, open AGI platform, agent engineering, San Francisco AI jobs, Belgrade AI jobs, startup hiring',
    openGraph: {
      title: socialTitle,
      description,
      url: `${CANONICAL_ORIGIN}/careers`,
      images: [
        {
          url: '/images/careers/shackleton.png',
          width: 380,
          height: 253,
          alt: t.raw('text206d4796597e'),
        },
      ],
    },
    twitter: {
      card: 'summary_large_image',
      title: socialTitle,
      description,
      images: ['/images/careers/shackleton.png'],
    },
    alternates: {
      canonical: `${CANONICAL_ORIGIN}/careers`,
    },
  };
}

export default function CareersPage() {
  return <CareersPageContent />;
}

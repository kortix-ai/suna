import { CareersPage as CareersPageContent } from '@/features/marketing/careers/careers-page';
import { CANONICAL_ORIGIN } from '@/lib/site-metadata';
import type { Metadata } from 'next';

const DESCRIPTION =
  'Open positions at Kortix — Marketing / Content, Sales, FDE / Services, Product / Eng, Product / R&D. Belgrade, Serbia and San Francisco. We hire for prolonged ownership.';

export const metadata: Metadata = {
  title: 'Careers',
  description: DESCRIPTION,
  keywords:
    'Kortix careers, Kortix jobs, AI startup jobs, open AGI platform, agent engineering, San Francisco AI jobs, Belgrade AI jobs, startup hiring',
  openGraph: {
    title: 'Careers at Kortix – Open positions',
    description: DESCRIPTION,
    url: `${CANONICAL_ORIGIN}/careers`,
    images: [
      {
        url: '/images/careers/shackleton.png',
        width: 380,
        height: 253,
        alt: 'Careers at Kortix',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Careers at Kortix – Open positions',
    description: DESCRIPTION,
    images: ['/images/careers/shackleton.png'],
  },
  alternates: {
    canonical: `${CANONICAL_ORIGIN}/careers`,
  },
};

export default function CareersPage() {
  return <CareersPageContent />;
}

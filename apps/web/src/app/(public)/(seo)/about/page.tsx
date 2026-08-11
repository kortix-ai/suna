import { AboutPage as AboutPageContent } from '@/features/marketing/about/about-page';
import { CANONICAL_ORIGIN } from '@/lib/site-metadata';
import type { Metadata } from 'next';

const DESCRIPTION =
  'dosco is building the dosco agent network. A company owns all of it — every agent, all of their data, every skill, every connector, the memory, the whole configuration, on their own infrastructure.';

export const metadata: Metadata = {
  title: 'About',
  description: DESCRIPTION,
  keywords:
    'dosco, about dosco, dosco agent platform, agent-native AI management system, autonomous companies, AI agents, self-hosted agent platform',
  openGraph: {
    title: 'About dosco – The dosco agent platform',
    description: DESCRIPTION,
    url: `${CANONICAL_ORIGIN}/about`,
    images: [
      {
        url: '/images/team.webp',
        width: 1200,
        height: 675,
        alt: 'The dosco team',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'About dosco – The dosco agent platform',
    description: DESCRIPTION,
    images: ['/images/team.webp'],
  },
  alternates: {
    canonical: `${CANONICAL_ORIGIN}/about`,
  },
};

export default function AboutPage() {
  return <AboutPageContent />;
}

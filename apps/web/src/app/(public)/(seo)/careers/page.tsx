import type { Metadata } from 'next';
import CareersPageClient from './careers-client';

export const metadata: Metadata = {
  title: 'Careers',
  description:
    'Join a small, tight-knit team building the operating system for autonomous companies. We hire founders, builders, and craftspeople who turn chaos into systems that run themselves. San Francisco and remote.',
  keywords:
    'Kortix careers, Kortix jobs, AI startup jobs, autonomous company jobs, San Francisco AI jobs, agent engineering, startup hiring',
  openGraph: {
    title: 'Careers at Kortix – Build the Autonomous Company OS',
    description:
      'An extremely small, tight-knit team building the operating system for autonomous companies. Founders, builders, hackers, engineers — we care that you\'ve built something real.',
    url: 'https://www.kortix.com/careers',
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
    title: 'Careers at Kortix – Build the Autonomous Company OS',
    description:
      'An extremely small, tight-knit team building the operating system for autonomous companies. Founders, builders, hackers, engineers — we care that you\'ve built something real.',
    images: ['/images/careers/shackleton.png'],
  },
  alternates: {
    canonical: 'https://www.kortix.com/careers',
  },
};

export default function CareersPage() {
  return <CareersPageClient />;
}

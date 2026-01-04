import { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Workers 101 | Kortix',
  description: 'An introduction to AI Workers. Learn what AI workers are, how they work, and how to build them.',
  openGraph: {
    title: 'Workers 101 | Kortix',
    description: 'An introduction to AI Workers.',
    url: 'https://www.kortix.com/agents-101',
    siteName: 'Kortix',
    images: [{ url: '/banner.png', width: 1200, height: 630 }],
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Workers 101 | Kortix',
    description: 'An introduction to AI Workers.',
    images: ['/banner.png'],
  },
};

export default function Agents101Layout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}

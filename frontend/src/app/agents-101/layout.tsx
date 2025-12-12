import { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Agents 101 | Kortix',
  description: 'An introduction to AI Agents. Learn what AI agents are, how they work, and how to build them.',
  openGraph: {
    title: 'Agents 101 | Kortix',
    description: 'An introduction to AI Agents.',
    url: 'https://www.kortix.com/agents-101',
    siteName: 'Kortix',
    images: [{ url: '/banner.png', width: 1200, height: 630 }],
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Agents 101 | Kortix',
    description: 'An introduction to AI Agents.',
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

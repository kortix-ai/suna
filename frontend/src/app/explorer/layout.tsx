import { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Explorer | Kortix',
  description: 'Explore the knowledge universe powered by Kortix AI',
  openGraph: {
    title: 'Explorer | Kortix',
    description: 'Explore the knowledge universe powered by Kortix AI',
    url: 'https://kortix.com/explorer',
    siteName: 'Kortix',
    images: [{ url: '/banner.png', width: 1200, height: 630 }],
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Explorer | Kortix',
    description: 'Explore the knowledge universe powered by Kortix AI',
    images: ['/banner.png'],
  },
};

export default function ExplorerLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}

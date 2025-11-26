import { Metadata } from 'next';
import { HomeLayoutClient } from './layout-client';

// Static metadata for SEO - rendered in initial HTML
export const metadata: Metadata = {
  title: 'Kortix: Your Autonomous AI Worker',
  description: 'Built for complex tasks, designed for everything. The ultimate AI assistant that handles it all—from simple requests to mega-complex projects.',
  keywords: 'Kortix, Autonomous AI Worker, AI Worker, Generalist AI, Open Source AI, Autonomous Agent, Complex Tasks, AI Assistant',
  openGraph: {
    title: 'Kortix: Your Autonomous AI Worker',
    description: 'Built for complex tasks, designed for everything. The ultimate AI assistant that handles it all—from simple requests to mega-complex projects.',
    url: 'https://kortix.com',
    siteName: 'Kortix',
    images: [{ url: '/banner.png', width: 1200, height: 630 }],
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Kortix: Your Autonomous AI Worker',
    description: 'Built for complex tasks, designed for everything. The ultimate AI assistant that handles it all—from simple requests to mega-complex projects.',
    images: ['/banner.png'],
  },
};

export default function HomeLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return <HomeLayoutClient>{children}</HomeLayoutClient>;
}

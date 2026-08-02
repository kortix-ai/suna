import { HelpLayoutClient } from '@/components/help/help-layout-client';
import { marketingMetadata } from '@/lib/seo/metadata';
import type { Metadata } from 'next';

export const metadata: Metadata = marketingMetadata('/help');

interface HelpLayoutProps {
  children: React.ReactNode;
}

export default function HelpLayout({
  children,
}: HelpLayoutProps) {
  return <HelpLayoutClient>{children}</HelpLayoutClient>;
}

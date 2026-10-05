import { localizedMarketingMetadata } from '@/lib/seo/metadata';
import type { ReactNode } from 'react';

export function generateMetadata() {
  return localizedMarketingMetadata('/contact');
}

export default function ContactLayout({ children }: { children: ReactNode }) {
  return children;
}

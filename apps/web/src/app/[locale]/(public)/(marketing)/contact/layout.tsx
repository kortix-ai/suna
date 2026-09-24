import { marketingMetadata } from '@/lib/seo/metadata';
import type { ReactNode } from 'react';

export const metadata = marketingMetadata('/contact');

export default function ContactLayout({ children }: { children: ReactNode }) {
  return children;
}

import type { Metadata } from 'next';
import { getTranslations } from '@/i18n/get-translations';
import type { ReactNode } from 'react';

// Internal living design-system reference — public for sharing, not for search.
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('hardcodedUi.i18nComplete');
  return {
    title: t.raw('text4eda8c966e9b'),
    robots: { index: false, follow: false },
  };
}

export default function DesignSystemLayout({ children }: { children: ReactNode }) {
  return children;
}

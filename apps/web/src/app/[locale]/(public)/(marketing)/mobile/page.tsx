import { getLocalizedSurface } from '@/features/marketing/surfaces/content';
import { MobileStage } from '@/features/marketing/surfaces/stages';
import { SurfacePage } from '@/features/marketing/surfaces/surface-page';
import { getTranslations } from '@/i18n/get-translations';
import { localizedMarketingMetadata } from '@/lib/seo/metadata';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export function generateMetadata(): Promise<Metadata> {
  return localizedMarketingMetadata('/mobile');
}

/** `/mobile`: copy in features/marketing/surfaces/content.ts, layout in surface-page.tsx. */
export default async function Page(): Promise<ReactNode> {
  const tI18nComplete = await getTranslations('hardcodedUi.i18nComplete');
  return <SurfacePage content={getLocalizedSurface('mobile', tI18nComplete)} stage={<MobileStage />} />;
}

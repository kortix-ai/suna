import { getLocalizedChannel } from '@/features/marketing/surfaces/channel-content';
import { ChannelPage } from '@/features/marketing/surfaces/channel-page';
import { getLocalizedSurface } from '@/features/marketing/surfaces/content';
import { SlackStage } from '@/features/marketing/surfaces/stages';
import { getTranslations } from '@/i18n/get-translations';
import { localizedMarketingMetadata } from '@/lib/seo/metadata';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export function generateMetadata(): Promise<Metadata> {
  return localizedMarketingMetadata('/slack');
}

/** `/slack`: hero copy in surfaces/content.ts, the sections in surfaces/channel-content.ts. */
export default async function Page(): Promise<ReactNode> {
  const tI18nComplete = await getTranslations('hardcodedUi.i18nComplete');
  return (
    <ChannelPage
      surface={getLocalizedSurface('slack', tI18nComplete)}
      channel={getLocalizedChannel('slack', tI18nComplete)}
      stage={<SlackStage />}
    />
  );
}

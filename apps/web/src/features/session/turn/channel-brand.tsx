'use client';

import { MicrosoftTeams } from '@/features/icon/icons/microsoft-teams';
import { Slack } from '@/features/icon/icons/slack';
import type { UiTranslator } from '@/i18n/translator';
import type { ChannelPlatform } from './channel-message';

/**
 * One source for how a chat channel is drawn in a session: its mark and its
 * brand hue. Used by the incoming channel card (`user-message.tsx`) and by the
 * outgoing reply card the bash tool renders for `teams send` / `slack send` /
 * `telegram send` (`tool/tools/channel-send-card.tsx`), so a message and its
 * reply carry the same badge.
 *
 * The hues are the platforms' own brand colors, not themeable tokens — which
 * is why they live here as named constants rather than as classes. Slack has
 * none to tint a label with: its mark is four colors and its wordmark is the
 * text color, black or white. It was Material pink (#E91E63).
 */
export const CHANNEL_BRAND_COLOR: Record<ChannelPlatform, string | undefined> = {
  Telegram: '#29B6F6',
  Slack: undefined,
  Teams: '#5B5FC7',
};

const TELEGRAM_PATH =
  'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69a.2.2 0 00-.05-.18c-.06-.05-.14-.03-.21-.02-.09.02-1.49.95-4.22 2.79-.4.27-.76.41-1.08.4-.36-.01-1.04-.2-1.55-.37-.63-.2-1.12-.31-1.08-.66.02-.18.27-.36.74-.55 2.92-1.27 4.86-2.11 5.83-2.51 2.78-1.16 3.35-1.36 3.73-1.36.08 0 .27.02.39.12.1.08.13.19.14.27-.01.06.01.24 0 .38z';


/** The platform's own mark, in its brand colors. */
export function ChannelBrandMark({
  platform,
  className = 'size-3.5 shrink-0',
}: {
  platform: ChannelPlatform;
  className?: string;
}) {
  if (platform === 'Teams') return <MicrosoftTeams className={className} />;
  if (platform === 'Slack') return <Slack className={className} />;
  return (
    <svg className={className} viewBox="0 0 24 24" fill={CHANNEL_BRAND_COLOR.Telegram} aria-hidden="true">
      <path d={TELEGRAM_PATH} />
    </svg>
  );
}

/** The platform's display name; only Teams has a catalog string (its full name). */
export function channelPlatformLabel(platform: ChannelPlatform, tI18nComplete: UiTranslator): string {
  return platform === 'Teams' ? tI18nComplete.raw('texta7b52b269a23') : platform;
}

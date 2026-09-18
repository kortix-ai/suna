'use client';

import { MicrosoftTeams } from '@/features/icon/icons/microsoft-teams';
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
 * is why they live here as named constants rather than as classes.
 */
export const CHANNEL_BRAND_COLOR: Record<ChannelPlatform, string> = {
  Telegram: '#29B6F6',
  Slack: '#E91E63',
  Teams: '#5B5FC7',
};

const TELEGRAM_PATH =
  'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69a.2.2 0 00-.05-.18c-.06-.05-.14-.03-.21-.02-.09.02-1.49.95-4.22 2.79-.4.27-.76.41-1.08.4-.36-.01-1.04-.2-1.55-.37-.63-.2-1.12-.31-1.08-.66.02-.18.27-.36.74-.55 2.92-1.27 4.86-2.11 5.83-2.51 2.78-1.16 3.35-1.36 3.73-1.36.08 0 .27.02.39.12.1.08.13.19.14.27-.01.06.01.24 0 .38z';

const SLACK_PATH =
  'M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z';

/** The platform's mark in its brand hue. */
export function ChannelBrandMark({
  platform,
  className = 'size-3.5 shrink-0',
}: {
  platform: ChannelPlatform;
  className?: string;
}) {
  if (platform === 'Teams') return <MicrosoftTeams className={className} />;
  return (
    <svg className={className} viewBox="0 0 24 24" fill={CHANNEL_BRAND_COLOR[platform]} aria-hidden="true">
      <path d={platform === 'Telegram' ? TELEGRAM_PATH : SLACK_PATH} />
    </svg>
  );
}

/** The platform's display name; only Teams has a catalog string (its full name). */
export function channelPlatformLabel(platform: ChannelPlatform, tI18nComplete: UiTranslator): string {
  return platform === 'Teams' ? tI18nComplete.raw('texta7b52b269a23') : platform;
}

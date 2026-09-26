'use client';

import { CHANNEL_BRAND_COLOR, ChannelBrandMark, channelPlatformLabel } from '@/features/session/turn/channel-brand';
import type { ChannelPlatform } from '@/features/session/turn/channel-message';
import { useTranslations } from '@/i18n/use-translations';
import { PaperclipIcon } from '@phosphor-icons/react';
import type { ChannelSend } from './channel-send';

const REPLIED_IN_KEY: Record<ChannelPlatform, string> = {
  Teams: 'text72b5b0c53de9',
  Slack: 'textfc73e9ad2dae',
  Telegram: 'text8faf56a14a8d',
};

/** "Replied in Microsoft Teams" — the row title for a channel send. */
export function channelSendTitle(platform: ChannelPlatform, tI18nComplete: ReturnType<typeof useTranslations>): string {
  return tI18nComplete.raw(REPLIED_IN_KEY[platform]);
}

/**
 * The reply as the person in the channel saw it: a left-anchored card with the
 * platform badge, the text verbatim, and the attachment name when a file went
 * with it. Its incoming twin is the channel card in `turn/user-message.tsx`;
 * they share `ChannelBrandMark` so a message and its answer wear one badge.
 */
export function ChannelSendCard({ send }: { send: ChannelSend }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const color = CHANNEL_BRAND_COLOR[send.platform];
  return (
    <div className="border-border/60 bg-muted/40 flex max-w-[80%] flex-col gap-1.5 rounded-lg border px-4 py-2.5">
      <div className="flex items-center gap-2">
        <ChannelBrandMark platform={send.platform} />
        <span className="text-xs font-medium" style={{ color }}>
          {channelPlatformLabel(send.platform, tI18nComplete)}
        </span>
        {send.channel ? (
          <>
            <span className="text-muted-foreground text-xs">·</span>
            <span className="text-muted-foreground font-mono text-xs">{send.channel}</span>
          </>
        ) : null}
      </div>
      {send.text ? (
        <div className="text-foreground text-sm whitespace-pre-wrap wrap-break-word">{send.text}</div>
      ) : null}
      {send.file ? (
        <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <PaperclipIcon className="size-3.5 shrink-0" />
          <span className="font-mono">{send.file}</span>
        </div>
      ) : null}
    </div>
  );
}

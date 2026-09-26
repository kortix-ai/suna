'use client';

import Image from 'next/image';

import { cn } from '@/lib/utils';

/** Third-party brand asset: Slack's own favicon at 128px. */
export const SLACK_ICON_SRC = 'https://www.google.com/s2/favicons?domain=slack.com&sz=128';

/**
 * The real Slack logo — the single Slack mark used everywhere across the
 * connectors + channels surface (catalogue cards, channel cards, connect flow,
 * the connected Slack channel's tile), so Slack always reads as Slack and never
 * as a generic glyph. Sized by `className`; defaults to `size-4`.
 *
 * Its own module, not `connectors-view.tsx`: the connectors grid renders it
 * through `ConnectorAppIcon`, and that route must not import the connectors
 * view (`connectors-page.chunk.test.ts`).
 */
export function SlackLogo({ className }: { className?: string }) {
  return (
    <span className={cn('relative inline-flex size-4 shrink-0', className)}>
      <Image
        src={SLACK_ICON_SRC}
        alt=""
        referrerPolicy="no-referrer"
        fill
        sizes="32px"
        className="object-contain"
        unoptimized
      />
    </span>
  );
}

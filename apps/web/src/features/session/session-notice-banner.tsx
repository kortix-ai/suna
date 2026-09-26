'use client';

import { InfoBanner } from '@/components/ui/info-banner';
import { type StatusTone } from '@/components/ui/status';
import { WarningCircleIcon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';

/**
 * A session state shown ABOVE a readable conversation, never in front of it.
 *
 * A start failure, a stopped session with no computer, and a lost computer each
 * replaced the whole session with a full-screen card, even when the
 * conversation was on screen a moment earlier: the saved copy paints the
 * transcript before the computer answers, so the card hid history the user
 * could read. The same state, its words and its action now sit in this banner,
 * at the position `SessionConnectingBanner` takes while a computer boots.
 */
export function SessionNoticeBanner({
  tone = 'warning',
  title,
  message,
  action,
}: {
  tone?: StatusTone;
  title: string;
  message?: string;
  action?: ReactNode;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      data-session-notice-banner=""
      className="pointer-events-none absolute inset-x-0 top-0 z-30 flex justify-center px-3 pt-3"
    >
      {/* Solid ground under the banner's tinted fill, so the thread behind it
          never shows through. */}
      <div className="bg-background pointer-events-auto w-full max-w-xl rounded-md shadow-xs">
        <InfoBanner tone={tone} icon={WarningCircleIcon} title={title} action={action}>
          {message}
        </InfoBanner>
      </div>
    </div>
  );
}

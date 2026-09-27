'use client';

import { InfoBanner } from '@/components/ui/info-banner';
import { type StatusTone } from '@/components/ui/status';
import { WarningCircleIcon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';

export interface SessionNoticeProps {
  tone?: StatusTone;
  title: string;
  message?: string;
  action?: ReactNode;
}

/**
 * A session state that ends what the conversation can do, told beside a
 * readable conversation instead of in place of it.
 *
 * A start failure, a stopped session with no computer, and a lost computer each
 * replaced the whole session with a full-screen card, even when the
 * conversation was on screen a moment earlier: the saved copy paints the
 * transcript before the computer answers, so the card hid history the user
 * could read. The same state, its words and its action now sit in the
 * composer's slot (`SessionChat`'s `inputReplacement`): nothing can be sent,
 * and nothing covers the thread.
 */
export function SessionNotice({ tone = 'warning', title, message, action }: SessionNoticeProps) {
  return (
    <div role="status" aria-live="polite" data-session-notice-banner="">
      <InfoBanner tone={tone} icon={WarningCircleIcon} title={title} action={action}>
        {message}
      </InfoBanner>
    </div>
  );
}

/**
 * The same notice above the thread, at the position `SessionConnectingBanner`
 * takes while a computer boots: for the rare state where the conversation is
 * readable but its chat cannot mount, so there is no composer slot to take.
 */
export function SessionNoticeBanner(props: SessionNoticeProps) {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-30 flex justify-center px-3 pt-3">
      {/* Solid ground under the banner's tinted fill, so the thread behind it
          never shows through. */}
      <div className="bg-background pointer-events-auto w-full max-w-xl rounded-md shadow-xs">
        <SessionNotice {...props} />
      </div>
    </div>
  );
}

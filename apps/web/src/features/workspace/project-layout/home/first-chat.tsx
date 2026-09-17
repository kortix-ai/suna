'use client';

import { BrainIcon, PlugIcon } from '@phosphor-icons/react';
import { useId, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { useAuth } from '@/features/providers/auth-provider';
import { SESSION_TRANSCRIPT_CLASS } from '@/features/session/session-transcript-class';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';

import { firstNameOf } from './first-chat-name';

/**
 * "Your first chat with Kortix": what project home shows a new person instead
 * of its usual greeting, until they send their first message.
 *
 * It is laid out as a chat, not as the home hero. The welcome sits where the
 * first assistant message would, in the transcript column a session uses, and
 * the composer is docked at the bottom. Sending opens a real session with the
 * composer already where it stays, so nothing jumps.
 *
 * The welcome is static text. No session exists and no turn runs until the
 * person sends something. The two starters are the only shortcuts:
 * - "Recommend tools" fills the composer and waits for the person to send.
 * - "Update memory" sends at once, because its first reply is Kortix's first
 *   question.
 *
 * The welcome fades in once, over 300ms. It is opacity only, so reduced motion
 * needs no other variant.
 */
export function FirstChat({
  composer,
  busy,
  onRecommendTools,
  onUpdateMemory,
}: {
  /** The docked composer. Project home owns its wiring. */
  composer: ReactNode;
  /** A send is in flight: the starters wait with the composer. */
  busy: boolean;
  onRecommendTools: () => void;
  onUpdateMemory: () => void;
}) {
  const t = useTranslations('firstChat');
  const { user } = useAuth();
  const name = firstNameOf(user?.user_metadata);
  const headingId = useId();

  return (
    <div className="relative z-10 flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <section
          aria-labelledby={headingId}
          className={cn(
            SESSION_TRANSCRIPT_CLASS,
            // Below the floating sidebar toggle, and a little lower on wide
            // screens where the column has room to breathe.
            'flex flex-col gap-6 pt-16 pb-8 lg:pt-24',
            'transition-opacity duration-(--duration-slow) ease-out starting:opacity-0',
          )}
        >
          <div className="flex flex-col gap-3">
            <h1 id={headingId} className="text-foreground text-xl font-medium text-balance">
              {name ? t('greeting', { name }) : t('greetingNoName')}
            </h1>
            <p className="text-foreground text-sm leading-relaxed text-pretty">{t('intro')}</p>
            <p className="text-foreground text-sm leading-relaxed">{t('question')}</p>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5"
              disabled={busy}
              onClick={onRecommendTools}
            >
              <PlugIcon className="size-3.5 shrink-0" />
              {t('recommendTools')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5"
              disabled={busy}
              onClick={onUpdateMemory}
            >
              <BrainIcon className="size-3.5 shrink-0" />
              {t('updateMemory')}
            </Button>
          </div>
        </section>
      </div>

      {composer}
    </div>
  );
}

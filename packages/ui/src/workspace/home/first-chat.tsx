'use client';

import {
  AppWindowIcon,
  BriefcaseIcon,
  ChatsCircleIcon,
  ClockIcon,
  GrainsIcon,
  PlugsConnectedIcon,
  type Icon,
} from '@phosphor-icons/react';
import { useId, type ReactNode } from 'react';

import { useUiViewer } from '../../providers/ui-provider';
import { SESSION_TRANSCRIPT_CLASS } from '../../session/thread/session-transcript-class';
import { useTranslations } from '../../i18n';
import { cn } from '../../internal/lib/utils';

import { firstNameOf } from './first-chat-name';

/** What Kortix does, in the order a new person meets it. Keys under `firstChat.can`. */
const CAPABILITIES: ReadonlyArray<{ key: string; icon: Icon }> = [
  { key: 'work', icon: BriefcaseIcon },
  { key: 'memory', icon: GrainsIcon },
  { key: 'tools', icon: PlugsConnectedIcon },
  { key: 'chat', icon: ChatsCircleIcon },
  { key: 'schedule', icon: ClockIcon },
  { key: 'apps', icon: AppWindowIcon },
];

/**
 * "Your first chat with Kortix": what project home shows a new person instead
 * of its usual greeting, until they send their first message.
 *
 * It is laid out as a chat, not as the home hero. The welcome sits where the
 * first assistant message would, in the transcript column a session uses, and
 * the composer is docked at the bottom. Sending opens a real session with the
 * composer already where it stays, so nothing jumps.
 *
 * The welcome is static text, and it stays: it is never replaced by a
 * session. Every send from here starts a new session and opens it; coming
 * back to project home shows this welcome again.
 *
 * It reads as one short message: a greeting, one line of intro, then what
 * Kortix can do — six items to read, not to click — and one line that points
 * at the composer. A new project's composer holds "Onboard me" here
 * (`project-home.tsx`); the agent's guided setup does the connecting and
 * inviting the items describe.
 *
 * The welcome fades in once, over 300ms. It is opacity only, so reduced motion
 * needs no other variant.
 */
export function FirstChat({ composer }: { composer: ReactNode }) {
  const t = useTranslations('firstChat');
  const user = useUiViewer();
  const name = firstNameOf(user?.metadata);
  const headingId = useId();
  const canId = useId();

  return (
    <div className="relative z-10 flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <section
          aria-labelledby={headingId}
          className={cn(
            SESSION_TRANSCRIPT_CLASS,
            // Below the floating sidebar toggle, and a little lower on wide
            // screens where the column has room to breathe.
            'flex flex-col gap-10 pt-16 pb-8 lg:pt-24',
            'transition-opacity duration-(--duration-slow) ease-out starting:opacity-0',
          )}
        >
          <div className="flex flex-col gap-3">
            <h1
              id={headingId}
              className="text-foreground text-2xl font-medium tracking-tight text-balance"
            >
              {name ? t('greeting', { name }) : t('greetingNoName')}
            </h1>
            <p className="text-muted-foreground max-w-prose text-base leading-7 text-pretty">
              {t('intro')}
            </p>
          </div>

          <div className="flex flex-col gap-4">
            <h2 id={canId} className="text-foreground text-base font-medium">
              {t('canTitle')}
            </h2>
            <ul aria-labelledby={canId} className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {CAPABILITIES.map(({ key, icon: Glyph }) => (
                <li
                  key={key}
                  className="border-border bg-popover flex flex-col gap-3 rounded-md border p-4"
                >
                  <span className="bg-muted text-foreground flex size-8 items-center justify-center rounded-sm">
                    <Glyph className="size-4" aria-hidden />
                  </span>
                  <span className="flex flex-col gap-1">
                    <span className="text-foreground text-sm leading-5 font-medium">
                      {t(`can.${key}.title`)}
                    </span>
                    <span className="text-muted-foreground text-sm leading-5 text-pretty">
                      {t(`can.${key}.body`)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground text-sm leading-5 text-pretty">{t('startHint')}</p>
          </div>
        </section>
      </div>

      {composer}
    </div>
  );
}

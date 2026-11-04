'use client';

import type { ProjectAccessRequest } from '@kortix/sdk';
import { BellIcon, UserPlusIcon } from '@phosphor-icons/react';
import { AnimatePresence, m, useReducedMotion } from 'motion/react';
import { useState } from 'react';

import { BellMark } from '../../internal/notifications/notification-bell';
import { HubLink } from '../../internal/account-hub/account-hub-location';
import { hubTarget, type HubTarget } from '../../internal/stores/account-panel-store';
import { Button } from '../../primitives/button';
import { FadedScrollArea } from '../../primitives/faded-scroll-area';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../../primitives/hover-card';
import { UserAvatar } from '../../primitives/user-avatar';
import { useLocale, useTranslations } from '../../i18n';
import { relativeTime } from '../../internal/lib/relative-time';
import { cn } from '../../internal/lib/utils';

/**
 * The pending-access-requests control, floated over the hero's top-right
 * corner. With the project's `notification_center` flag on, its glyph is a
 * person with a plus, not a bell: the bell is then the notification inbox
 * (KRTX-1742), and two bells on one screen would read as one control. With
 * the flag off there is no inbox bell, and the glyph stays the bell.
 *
 * It draws its count with the inbox's `BellMark`, in the yellow "needs you"
 * tone: a request waits on the person, so it reads like the sidebar bell.
 * Hover opens the people card of the session header's participant stack:
 * who asked and when, with one way to review.
 *
 * ## One button, not two
 *
 * The destination needs the project's `account_id`, which arrives on its own
 * query — so for the first paint there is a count but no href. That used to be
 * two fully written-out `<Button>` branches that had to be kept byte-identical
 * by hand. `asChild` already models exactly this: hand it a `HubLink` when
 * there is somewhere to go, and let it render its own `<button>` when there is
 * not. Same box, same size, click inert until the account id lands — never a
 * broken destination.
 *
 * ## Motion
 *
 * A request arriving is rare and it is the whole point of the control, so the
 * badge earns an enter: it fades and scales up from 0.95, never from 0. Exit
 * runs at 80% of the enter. Under reduced motion the scale is dropped and the
 * fade stays, because the fade is what says "this is new".
 */
export function AccessRequestsBell({
  requests,
  to,
  notificationCenter = false,
  className,
}: {
  /** The project's pending access requests, newest last as the API returns them. */
  requests: ProjectAccessRequest[];
  /** The account hub's Access › Projects pane, scoped to this project.
   *  `null` while `account_id` is still loading — the bell renders inert. */
  to: HubTarget | null;
  /** The project's `notification_center` flag: on, the inbox owns the bell glyph. */
  notificationCenter?: boolean;
  className?: string;
}) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const locale = useLocale();
  const reduceMotion = useReducedMotion();
  const [open, setOpen] = useState(false);
  const count = requests.length;
  const label = `${count} pending access request${count === 1 ? '' : 's'}`;
  const Glyph = notificationCenter ? UserPlusIcon : BellIcon;

  const body = <BellMark count={count} needsYou icon={Glyph} />;

  return (
    <AnimatePresence>
      {count > 0 && (
        <m.div
          key="access-requests-bell"
          initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.95 }}
          animate={{
            opacity: 1,
            scale: 1,
            transition: { duration: 0.15, ease: [0.23, 1, 0.32, 1] },
          }}
          exit={{
            opacity: 0,
            scale: reduceMotion ? 1 : 0.95,
            transition: { duration: 0.12, ease: [0.23, 1, 0.32, 1] },
          }}
          className={cn('absolute top-2 right-2 z-20', className)}
        >
          <HoverCard open={open} onOpenChange={setOpen} openDelay={300} closeDelay={100}>
            <HoverCardTrigger asChild>
              <Button
                asChild={Boolean(to)}
                type="button"
                variant="ghost"
                size="icon"
                className="relative shrink-0"
                aria-label={label}
              >
                {to ? <HubLink to={to}>{body}</HubLink> : body}
              </Button>
            </HoverCardTrigger>
            {/* The participant stack's card: a label and count, then rows in a
                capped scroll area. Not animated, for the same reason. */}
            <HoverCardContent
              side="bottom"
              align="end"
              sideOffset={6}
              animated={false}
              className="w-80 overflow-hidden p-0"
              onEscapeKeyDown={() => setOpen(false)}
            >
              <div className="text-muted-foreground flex items-center justify-between px-3.5 pt-2.5 pb-1 text-xs">
                <span>{t.raw('textf810ceed99d6')}</span>
                <span className="tabular-nums">{count}</span>
              </div>
              <FadedScrollArea fadeColor="from-popover" fadeSize="6" className="max-h-64 overscroll-contain">
                <ul className="p-1 pt-0">
                  {/* Plain rows: the review happens in the account hub. */}
                  {requests.map((request) => (
                    <li key={request.request_id}>
                      <div className="text-foreground flex min-h-9 items-center gap-2.5 px-2 py-1 text-sm">
                        <UserAvatar email={request.requester_email} size="md" />
                        {/* Email and age read as one block: tight leading, no gap. */}
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate leading-tight">{request.requester_email}</span>
                          <span className="text-muted-foreground truncate text-xs leading-tight tabular-nums">
                            {t.raw('text2d9e28289fac')} {relativeTime(request.created_at, locale)}
                          </span>
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              </FadedScrollArea>
              {to ? (
                <div className="border-border border-t p-1">
                  <Button asChild variant="ghost" size="sm" className="w-full justify-center">
                    <HubLink to={to} onClick={() => setOpen(false)}>
                      {t.raw('textaff0766a5290')}
                    </HubLink>
                  </Button>
                </div>
              ) : null}
            </HoverCardContent>
          </HoverCard>
        </m.div>
      )}
    </AnimatePresence>
  );
}

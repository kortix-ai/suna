'use client';

import { BellIcon as Bell } from '@phosphor-icons/react';
import { AnimatePresence, m, useReducedMotion } from 'motion/react';

import { HubLink } from '@/features/accounts/hub/account-hub-location';
import { hubTarget, type HubTarget } from '@/stores/account-panel-store';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { cn } from '@/lib/utils';

/**
 * The pending-access-requests bell, floated over the hero's top-right corner.
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
  count,
  to,
  className,
}: {
  count: number;
  /** The account hub's Access › Projects pane, scoped to this project.
   *  `null` while `account_id` is still loading — the bell renders inert. */
  to: HubTarget | null;
  className?: string;
}) {
  const reduceMotion = useReducedMotion();
  const label = `${count} pending access request${count === 1 ? '' : 's'}`;

  const body = (
    <>
      <Bell className="size-4" />
      <Badge size="xs" variant="new" className="absolute -top-1 -right-1 min-w-5 px-1 tabular-nums">
        {count}
      </Badge>
    </>
  );

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
          className={cn('absolute top-4 right-4 z-20', className)}
        >
          <Hint label={label}>
            <Button
              asChild={Boolean(to)}
              type="button"
              variant="ghost"
              size="icon"
              className="bg-background/80 relative backdrop-blur-sm"
              aria-label={label}
            >
              {to ? <HubLink to={to}>{body}</HubLink> : body}
            </Button>
          </Hint>
        </m.div>
      )}
    </AnimatePresence>
  );
}

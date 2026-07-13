'use client';

import { CreditCard, KeyRound } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/features/layout/section/empty-state';
import { useModelConnectionGate } from './use-model-connection-gate';

/**
 * The single "no model connected" teaching moment — an icon, a plain-English
 * explanation, and the two ways out: upgrade to a Kortix plan, or bring an API
 * key from any provider. Shared by the chat input's full-block gate and the
 * project onboarding wizard so the copy and actions never drift apart.
 */
export function ModelConnectionGate({
  size = 'default',
  className,
}: {
  size?: 'sm' | 'default';
  className?: string;
}) {
  const { openConnectProvider, openUpgrade, modal } = useModelConnectionGate();

  return (
    <>
      {modal}
      <EmptyState
        className={className}
        icon={KeyRound}
        size={size}
        title="Connect a model to start chatting"
        description="This session needs an LLM connected before it can respond. Upgrade for instant access to Kortix's managed models, or bring your own API key from any provider."
        action={
          <Button type="button" size="sm" onClick={openUpgrade}>
            <CreditCard className="size-3.5" />
            Upgrade
          </Button>
        }
        secondaryAction={
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => openConnectProvider('providers')}
          >
            <KeyRound className="size-3.5" />
            Bring your own key
          </Button>
        }
      />
    </>
  );
}

// Enter waits a beat (delay) so the composer paints first, then the bar slides
// out from under it — height opens the space while the strip translates down,
// same spring on both so they move as one surface. Exit runs faster than enter
// and slides back under.
const BAR_ENTER = { type: 'spring', duration: 0.5, bounce: 0, delay: 0.15 } as const;
const BAR_EXIT = { type: 'spring', duration: 0.35, bounce: 0 } as const;

/**
 * Non-blocking variant of the gate — a slim status strip that slides out from
 * under the chat input card (the composer stays visible; sends are already
 * disabled by `modelUnavailable`). Left side says what's wrong, right side
 * offers the same two ways out as the full gate.
 *
 * `show` must only flip on settled data (see `entitlementsPending`) — the
 * animation assumes it renders once with the final answer, not per-query.
 */
export function ModelConnectionBar({ show }: { show: boolean }) {
  const { openConnectProvider, openUpgrade, modal } = useModelConnectionGate();
  const reduceMotion = useReducedMotion();

  return (
    <>
      {modal}
      <AnimatePresence initial={false}>
        {show && (
          <motion.div
            key="model-connection-bar"
            initial={reduceMotion ? { opacity: 0 } : { height: 0 }}
            animate={
              reduceMotion
                ? { opacity: 1, transition: { duration: 0.2 } }
                : { height: 'auto', transition: BAR_ENTER }
            }
            exit={
              reduceMotion
                ? { opacity: 0, transition: { duration: 0.15 } }
                : { height: 0, transition: BAR_EXIT }
            }
            className="relative z-0 overflow-hidden"
          >
            <motion.div
              initial={reduceMotion ? false : { y: '-100%' }}
              animate={reduceMotion ? undefined : { y: '0%', transition: BAR_ENTER }}
              exit={reduceMotion ? undefined : { y: '-100%', transition: BAR_EXIT }}
              className="border-border bg-foreground/10 dark:bg-accent mx-3 -mt-3 rounded-b-xl border"
            >
              <div className="flex items-center justify-between gap-3 pt-[18px] pr-2 pb-1.5 pl-4">
                <div className="text-muted-foreground flex min-w-0 items-center gap-2 text-xs">
                  <KeyRound className="size-3.5 shrink-0" />
                  <span className="truncate">
                    No model connected
                    <span className="hidden sm:inline"> — connect one to start chatting</span>
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={openUpgrade}
                    className="text-muted-foreground hover:text-foreground hover:bg-muted inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-xs font-medium transition-[color,background-color,transform] active:scale-[0.96]"
                  >
                    <CreditCard className="size-3.5" />
                    Upgrade
                  </button>
                  <button
                    type="button"
                    onClick={() => openConnectProvider('providers')}
                    className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-7 cursor-pointer items-center rounded-full px-3 text-xs font-medium transition-[background-color,transform] active:scale-[0.96]"
                  >
                    Connect model
                  </button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

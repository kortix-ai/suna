'use client';

import { CreditCardIcon, KeyIcon } from '@phosphor-icons/react';
import { AnimatePresence, m, useReducedMotion } from 'motion/react';

import { Button } from '@/components/ui/button';
import type { FlatModel } from './session-chat-input';
import { useModelConnectionGate } from './use-model-connection-gate';

/** Stable empty list so the hook's `models = []` default isn't re-allocated per render. */
const EMPTY_MODELS: FlatModel[] = [];

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
  const { openConnectProvider, openUpgrade, modal, showUpgradeOption } =
    useModelConnectionGate(EMPTY_MODELS);
  const reduceMotion = useReducedMotion();

  return (
    <>
      {modal}
      <AnimatePresence initial={false}>
        {show && (
          <m.div
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
            <m.div
              initial={reduceMotion ? false : { y: '-100%' }}
              animate={reduceMotion ? undefined : { y: '0%', transition: BAR_ENTER }}
              exit={reduceMotion ? undefined : { y: '-100%', transition: BAR_EXIT }}
              className="border-border bg-muted mx-3 -mt-3 rounded-b-md border"
            >
              <div className="flex items-center justify-between gap-3 pt-[18px] pr-2 pb-1.5 pl-4">
                <div className="text-muted-foreground flex min-w-0 items-center gap-2 text-xs">
                  <KeyIcon className="size-3.5 shrink-0" />
                  <span className="truncate">
                    No model connected
                    <span className="hidden sm:inline"> — connect one to start chatting</span>
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {showUpgradeOption && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={openUpgrade}
                      className="hit-area-1 gap-1.5 rounded-full text-xs"
                    >
                      <CreditCardIcon className="size-3.5 shrink-0" />
                      Upgrade
                    </Button>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => openConnectProvider('providers')}
                    className="hit-area-1 rounded-full text-xs"
                  >
                    Connect model
                  </Button>
                </div>
              </div>
            </m.div>
          </m.div>
        )}
      </AnimatePresence>
    </>
  );
}

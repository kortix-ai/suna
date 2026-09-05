'use client';

import { CreditCardIcon, KeyIcon } from '@phosphor-icons/react';
import { AnimatePresence, m, useReducedMotion } from 'motion/react';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/features/layout/section/empty-state';
import type { FlatModel } from './session-chat-input';
import { useModelConnectionGate } from './use-model-connection-gate';

/** Stable empty list so the hook's `models = []` default isn't re-allocated per render. */
const EMPTY_MODELS: FlatModel[] = [];

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
  const { openConnectProvider, openUpgrade, modal, showUpgradeOption } =
    useModelConnectionGate(EMPTY_MODELS);

  return (
    <>
      {modal}
      <EmptyState
        className={className}
        icon={KeyIcon}
        size={size}
        title="Connect a model to start chatting"
        description={
          showUpgradeOption
            ? "This session needs an LLM connected before it can respond. Upgrade for instant access to Kortix's managed models, or bring your own API key from any provider."
            : 'This session needs an LLM connected before it can respond. Bring your own API key from any provider.'
        }
        action={
          showUpgradeOption ? (
            <Button type="button" size="sm" onClick={openUpgrade}>
              <CreditCardIcon className="size-3.5" />
              Upgrade
            </Button>
          ) : (
            <Button type="button" size="sm" onClick={() => openConnectProvider('providers')}>
              <KeyIcon className="size-3.5" />
              Bring your own key
            </Button>
          )
        }
        secondaryAction={
          showUpgradeOption ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => openConnectProvider('providers')}
            >
              <KeyIcon className="size-3.5" />
              Bring your own key
            </Button>
          ) : undefined
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
 * ## It is a TRAY, not a box below the composer
 *
 * This renders as the card's next sibling and pulls itself UP behind it
 * (`-mt-4` on the clipper, cancelled by `pt-4` on the strip), so the card —
 * `isolate z-10`, opaque `bg-sidebar` — paints over the overlap. What is left
 * is one surface: the composer, with a deeper strip hanging off its bottom
 * edge and showing through the card's own rounded bottom corners.
 *
 * The overlap is why the card needs NO conditional radius. A flush seam would
 * have meant `rounded-b-none` on the card while this is mounted, and the card
 * would snap its corners back the instant `show` flipped — 350ms of square
 * corner sitting above a strip that is still animating out. Here the card is
 * untouched and only the tray moves.
 *
 * `-mt-4` lives on the clipper, never on the strip inside it: the clipper is
 * `overflow-hidden` for the height animation, so a negative margin on its
 * child would be clipped away instead of overlapping anything.
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
            className="relative z-0 -mt-4 overflow-hidden"
          >
            <m.div
              initial={reduceMotion ? false : { y: '-100%' }}
              animate={reduceMotion ? undefined : { y: '0%', transition: BAR_ENTER }}
              exit={reduceMotion ? undefined : { y: '-100%', transition: BAR_EXIT }}
              // `border-t-0`: the card's own bottom border is the seam. Drawing
              // one here too would put a second hairline under a card that
              // already has one. `rounded-b-xl` matches the card's radius so
              // the two share one silhouette; the top corners are square
              // because they live behind the card and are never seen.
              className="border-border bg-muted rounded-b-xl border border-t-0 pt-4"
            >
              <div className="flex items-center justify-between gap-3 px-3 py-1.5">
                <div className="text-muted-foreground flex min-w-0 items-center gap-2 text-xs">
                  <KeyIcon className="size-3.5 shrink-0" />
                  <span className="truncate">
                    No model connected
                    <span className="hidden sm:inline"> — connect one to start chatting</span>
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {showUpgradeOption && (
                    <Button type="button" variant="ghost" size="xs" onClick={openUpgrade}>
                      <CreditCardIcon className="size-3.5 shrink-0" />
                      Upgrade
                    </Button>
                  )}
                  <Button type="button" size="xs" onClick={() => openConnectProvider('providers')}>
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

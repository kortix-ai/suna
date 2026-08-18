'use client';

import { EASE_OUT, LEAD, panel } from '@/features/marketing/component/hero-motion';
import { cn } from '@/lib/utils';
import { CheckIcon } from '@phosphor-icons/react';
import { m, useReducedMotion } from 'motion/react';
import type { ReactNode } from 'react';
import { thread } from './content';

/**
 * `/channels` hero scene — one thread, bound to one session.
 *
 * A thread is a pile of messages that ends in a decision, so the scene is a
 * pile that ends in a decision.
 *
 * Composition:
 *  - the turns step down and to the right, each one narrower and dimmer than
 *    the one below it, and the first is cropped by the top edge — the
 *    conversation started before you got here;
 *  - the session bracket runs down the left of the whole pile with its label
 *    set vertically, because the binding is a property of the pile, not of any
 *    one message;
 *  - the approval card is the only full-contrast surface, sits lowest and
 *    widest, and overlaps the message above it.
 *
 * The reaction on the first message is the page's own detail: "you get a
 * reaction on your own message, not a bot post saying 'on it'".
 *
 * Every string is `thread.mock` verbatim, including the truncated-UUID session
 * id — the content file is explicit that this is what a branch name is.
 *
 * MOTION — one pass on mount, then rest.
 */

const { mock } = thread;
const TURNS = mock.turns;

export function ChannelsHeroVisual(): ReactNode {
  const reduceMotion = useReducedMotion() ?? false;

  return (
    <div
      className="flex w-full items-center justify-center"
      role="img"
      aria-label={`A ${mock.channel} thread bound to one session, ending in a change request offered for approval.`}
    >
      <div className="relative h-[24rem] w-full max-w-[38rem] overflow-hidden sm:h-[26rem]">
        {/* ── the channel, cut by the top edge ────────────────────────── */}
        <m.div
          className="absolute inset-x-[10%] top-[1%] flex items-center gap-2"
          initial={reduceMotion ? false : { opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.32, delay: 0.08, ease: EASE_OUT }}
          aria-hidden
        >
          <span className="text-muted-foreground/30 font-mono text-[12px]">#</span>
          <span className="text-muted-foreground/40 font-mono text-[11px]">
            {mock.channel.replace(/^#/, '')}
          </span>
          <span className="bg-border ml-1 h-px flex-1" />
        </m.div>

        {/* ── the session the whole pile belongs to ───────────────────── */}
        <m.span
          className="border-foreground/25 absolute z-20 w-2.5 origin-top rounded-l-md border-y border-l"
          style={{ left: '5%', top: '9%', bottom: '38%' }}
          initial={reduceMotion ? false : { scaleY: 0, opacity: 0 }}
          animate={{ scaleY: 1, opacity: 1 }}
          transition={{ duration: 0.44, delay: LEAD + 0.26, ease: EASE_OUT }}
          aria-hidden
        />
        <m.span
          className="text-muted-foreground/40 absolute z-20 font-mono text-[9px] tracking-[0.2em] uppercase [writing-mode:vertical-rl]"
          style={{ left: '0.5%', top: '11%' }}
          initial={reduceMotion ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.3, delay: LEAD + 0.42, ease: EASE_OUT }}
          aria-hidden
        >
          {mock.system.label} {mock.system.id}
        </m.span>

        {/* ── the pile ────────────────────────────────────────────────── */}
        {TURNS.map((turn, i) => {
          const back = TURNS.length - 1 - i; // 2 = furthest back
          return (
            <m.div
              key={turn.id}
              className={cn(
                'border-border/60 bg-card absolute rounded-xl border px-4 py-3',
                back === 0 ? 'shadow-lg' : 'shadow-md',
              )}
              style={{
                top: `${8 + i * 14}%`,
                left: `${10 + i * 4}%`,
                right: `${8 + back * 4}%`,
                zIndex: 10 + i,
              }}
              initial={reduceMotion ? false : { opacity: 0, y: 10 }}
              animate={{ opacity: 1 - back * 0.2, y: 0 }}
              transition={{ duration: 0.42, delay: LEAD + i * 0.09, ease: EASE_OUT }}
            >
              <span className="text-muted-foreground/50 block font-mono text-[10px]">
                {turn.who}
              </span>
              <span
                className={cn(
                  'mt-1 block leading-snug text-pretty',
                  turn.kind === 'file'
                    ? 'text-foreground font-mono text-[12px]'
                    : 'text-foreground/85 text-[12.5px]',
                )}
              >
                {turn.text}
              </span>

              {/* the page's own detail: a reaction, not a bot post */}
              {i === 0 ? (
                <m.span
                  className="border-border bg-background text-muted-foreground/60 absolute -bottom-2.5 left-4 inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 font-mono text-[9px]"
                  initial={reduceMotion ? false : { opacity: 0, scale: 0.85 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ duration: 0.28, delay: LEAD + 0.5, ease: EASE_OUT }}
                >
                  <CheckIcon className="size-2.5" aria-hidden />1
                </m.span>
              ) : null}
            </m.div>
          );
        })}

        {/* ── the decision ────────────────────────────────────────────── */}
        <m.div
          className="border-border/70 bg-card absolute right-[2%] bottom-[3%] left-[8%] z-30 rounded-xl border p-5 "
          {...panel(reduceMotion)}
        >
          <p className="text-foreground text-[14.5px] leading-snug font-medium text-pretty">
            {mock.review.title}
          </p>
          <p className="text-muted-foreground/55 mt-1.5 font-mono text-[11px]">
            {mock.review.body}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            {mock.review.actions.map((action, i) => (
              <span
                key={action}
                className={
                  i === 0
                    ? 'bg-foreground text-background rounded-md px-3 py-1.5 text-[11.5px] font-medium'
                    : 'border-border text-muted-foreground/55 rounded-md border px-3 py-1.5 text-[11.5px]'
                }
              >
                {action}
              </span>
            ))}
          </div>
        </m.div>
      </div>
    </div>
  );
}

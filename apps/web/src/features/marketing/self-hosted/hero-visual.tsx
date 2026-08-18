'use client';

import { EASE_OUT, LEAD, panel } from '@/features/marketing/component/hero-motion';
import { cn } from '@/lib/utils';
import { m, useReducedMotion } from 'motion/react';
import type { ReactNode } from 'react';
import { commands, stack } from './content';

/**
 * `/self-hosted` hero scene — the stack, stacked.
 *
 * "One Compose project, no hidden pieces" is a claim about depth, so the scene
 * has depth: the service groups are planes receding behind the terminal that
 * brought them up.
 *
 * Composition:
 *  - three planes, each stepped up and to the right, dimmer and thinner as they
 *    go back, with the last cropped by the top edge;
 *  - `kortix` lands nearest, `edge` furthest, matching how anyone thinks about
 *    their own stack;
 *  - a bracket down the left ties all three into one project, which is the
 *    whole claim — one Compose file, not three deployments;
 *  - the terminal sits lowest, widest and at full contrast, overlapping the
 *    nearest plane, because the command is the part you actually type.
 *
 * Group labels and service names are `stack.groups` verbatim; the terminal
 * lines are `commands.install.lines`, prompts and `→` output exactly as the
 * page renders them further down.
 *
 * MOTION — one pass on mount, then rest. The caret is the sanctioned exception.
 */

/** Nearest first. `stack.groups` runs kortix → data → edge, so this holds. */
const PLANES = stack.groups.slice(0, 3);

/** Three per plane keeps every plane one line tall, so the pile stays a pile. */
const PER_PLANE = 3;

const LINES = commands.install.lines.filter((line) => line !== '').slice(0, 5);

function Line({ line }: { line: string }): ReactNode {
  if (line.startsWith('#')) return <span className="text-muted-foreground/35">{line}</span>;
  if (line.startsWith('→')) return <span className="text-foreground/70">{line}</span>;
  if (line.startsWith('$')) {
    return (
      <>
        <span className="text-muted-foreground/40 select-none">$</span>
        <span className="text-foreground">{line.slice(1)}</span>
      </>
    );
  }
  return <span className="text-muted-foreground/60">{line}</span>;
}

export function SelfHostedHeroVisual(): ReactNode {
  const reduceMotion = useReducedMotion() ?? false;

  return (
    <div
      className="flex w-full items-center justify-center"
      role="img"
      aria-label="One Compose project: its service groups stacked as planes, and the terminal command that brought them up."
    >
      <div className="relative h-[24rem] w-full max-w-[38rem] overflow-hidden sm:h-[26rem]">
        {/* ── one project, holding the planes together ────────────────── */}
        <m.span
          className="border-border absolute w-2.5 origin-top rounded-l-md border-y border-l"
          style={{ left: '2%', top: '4%', bottom: '46%' }}
          initial={reduceMotion ? false : { scaleY: 0, opacity: 0 }}
          animate={{ scaleY: 1, opacity: 1 }}
          transition={{ duration: 0.44, delay: LEAD + 0.3, ease: EASE_OUT }}
          aria-hidden
        />
        <m.span
          className="text-muted-foreground/40 absolute font-mono text-[9px] tracking-[0.2em] uppercase [writing-mode:vertical-rl]"
          style={{ left: '-1%', top: '6%' }}
          initial={reduceMotion ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.3, delay: LEAD + 0.44, ease: EASE_OUT }}
          aria-hidden
        >
          one compose project
        </m.span>

        {/* ── the planes, receding up and right ───────────────────────── */}
        {PLANES.map((group, i) => {
          const back = i; // 0 = nearest
          return (
            <m.div
              key={group.id}
              className={cn(
                'border-border/60 bg-card absolute rounded-xl border px-4 py-3',
                back === 0 ? 'shadow-lg' : 'shadow-md',
              )}
              style={{
                top: `${24 - back * 9}%`,
                left: `${7 + back * 5}%`,
                right: `${4 + back * 2}%`,
                zIndex: 20 - back,
              }}
              initial={reduceMotion ? false : { opacity: 0, y: -8 }}
              animate={{ opacity: 1 - back * 0.24, y: 0 }}
              transition={{ duration: 0.44, delay: 0.08 + (2 - back) * 0.08, ease: EASE_OUT }}
            >
              <div className="flex items-center gap-3">
                <span className="text-muted-foreground/45 shrink-0 font-mono text-[10px] tracking-widest uppercase">
                  {group.label.split('—')[0]?.trim()}
                </span>
                <span className="bg-border h-px flex-1" />
              </div>
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {group.services.slice(0, PER_PLANE).map((service) => (
                  <span
                    key={service.k}
                    className="border-border/70 text-foreground/75 rounded-md border px-2 py-0.5 font-mono text-[10.5px]"
                  >
                    {service.k}
                  </span>
                ))}
                {group.services.length > PER_PLANE ? (
                  <span className="text-muted-foreground/35 self-center font-mono text-[10.5px]">
                    +{group.services.length - PER_PLANE}
                  </span>
                ) : null}
              </div>
            </m.div>
          );
        })}

        {/* ── the command that brought it up ──────────────────────────── */}
        <m.div
          className="border-border/70 bg-card absolute right-[8%] bottom-[3%] left-[1%] z-30 overflow-hidden rounded-xl border shadow-2xl"
          {...panel(reduceMotion)}
        >
          <div className="border-border/50 flex items-center gap-3 border-b px-4 py-2.5">
            <span className="text-muted-foreground/50 font-mono text-[10px] tracking-widest uppercase">
              {commands.install.title}
            </span>
          </div>
          <div className="bg-background/60 flex flex-col px-4 py-3.5">
            {LINES.map((line, i) => (
              <m.span
                key={`${line}-${i}`}
                className="flex gap-1.5 truncate font-mono text-[11.5px] leading-[1.9] whitespace-pre"
                initial={reduceMotion ? false : { opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3, delay: LEAD + 0.32 + i * 0.05, ease: EASE_OUT }}
              >
                <Line line={line} />
              </m.span>
            ))}
            <m.span
              className="flex items-center gap-1.5 font-mono text-[11.5px] leading-[1.9]"
              initial={reduceMotion ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{
                duration: 0.3,
                delay: LEAD + 0.32 + LINES.length * 0.05,
                ease: EASE_OUT,
              }}
            >
              <span className="text-muted-foreground/40 select-none">$</span>
              <span
                className={cn(
                  'bg-foreground inline-block h-3 w-[0.35rem]',
                  !reduceMotion && 'animate-blink-cursor',
                )}
              />
            </m.span>
          </div>
        </m.div>
      </div>
    </div>
  );
}

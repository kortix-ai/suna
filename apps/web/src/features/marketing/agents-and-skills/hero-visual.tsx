'use client';

import { EASE_OUT, LEAD, panel, reveal, STEP } from '@/features/marketing/component/hero-motion';
import { m, useReducedMotion } from 'motion/react';
import type { ReactNode } from 'react';
import { agent, skill } from './content';

/**
 * `/agents-and-skills` hero scene — two sheets.
 *
 * The page's own headline is "Two files. No hidden object behind them." So the
 * scene is two files: one behind, rotated off-axis and cropped by the top edge,
 * one in front, crisp and readable. The claim is the composition.
 *
 * Composition:
 *  - the back sheet is the skill, tilted −2.5°, pushed up and left until the
 *    frame cuts it — a document that exists whether or not you can see all of
 *    it;
 *  - the front sheet is the agent, square to the frame and fully legible;
 *  - only the front sheet gets full contrast and a real shadow, so the pair
 *    reads as depth rather than as two panels side by side.
 *
 * Lines are `agent.md.lines` and `skill.md.lines` verbatim, from the default
 * agent and the skill that ship in every new project.
 *
 * MOTION — one pass on mount, then rest.
 */

const LINES = agent.md.lines;
/** Frontmatter is delimited by the first two `---` lines. */
const CLOSE = LINES.indexOf('---', 1);
const FRONTMATTER = (CLOSE > 0 ? LINES.slice(1, CLOSE) : []).slice(0, 4);
const BODY = (CLOSE > 0 ? LINES.slice(CLOSE + 1) : LINES).filter((line) => line !== '').slice(0, 3);

/** The sheet behind: enough of the skill to read as a second document. */
const BACK = skill.md.lines.filter((line) => line !== '' && line !== '---').slice(0, 7);

function splitKey(line: string): { key: string; value: string } | null {
  const match = /^([a-z_][\w-]*):\s?(.*)$/.exec(line);
  return match ? { key: match[1]!, value: match[2]! } : null;
}

export function AgentsAndSkillsHeroVisual(): ReactNode {
  const reduceMotion = useReducedMotion() ?? false;

  return (
    <div
      className="flex w-full items-center justify-center"
      role="img"
      aria-label={`Two files: ${skill.md.title} behind, and ${agent.md.title} in front.`}
    >
      <div className="relative h-[23rem] w-full max-w-[38rem] sm:h-[26rem]">
        {/* ── the sheet behind, cut by the top edge ───────────────────── */}
        <m.div
          className="border-border/50 bg-card/60 absolute -top-[9%] right-[2%] left-[16%] rounded-lg border px-5 pt-5 pb-8 shadow-md"
          style={{ transform: 'rotate(-2.5deg)' }}
          initial={reduceMotion ? false : { opacity: 0, y: -10, rotate: -4 }}
          animate={{ opacity: 1, y: 0, rotate: -2.5 }}
          transition={{ duration: 0.5, delay: 0.06, ease: EASE_OUT }}
          aria-hidden
        >
          <span className="text-muted-foreground/40 block truncate font-mono text-[10px]">
            {skill.md.title}
          </span>
          <div className="mt-3 flex flex-col gap-1.5">
            {BACK.map((line, i) => (
              <span
                key={`${line}-${i}`}
                className="text-muted-foreground/30 truncate font-mono text-[10.5px]"
              >
                {line}
              </span>
            ))}
          </div>
        </m.div>

        <m.span
          className="text-muted-foreground/35 absolute top-[42%] left-0 font-mono text-[9px] tracking-[0.2em] uppercase [writing-mode:vertical-rl]"
          initial={reduceMotion ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.3, delay: LEAD + 0.5, ease: EASE_OUT }}
          aria-hidden
        >
          two files
        </m.span>

        {/* ── the sheet in front ──────────────────────────────────────── */}
        <m.div
          className="border-border/70 bg-card absolute right-[8%] bottom-[4%] left-[2%] overflow-hidden rounded-lg border "
          {...panel(reduceMotion)}
        >
          <div className="border-border/50 border-b px-5 py-3">
            <span className="text-muted-foreground/70 truncate font-mono text-[11px]">
              {agent.md.title}
            </span>
          </div>

          {/* the spec */}
          <div className="bg-background/40 border-border/40 border-b px-5 py-4">
            {FRONTMATTER.map((line, i) => {
              const pair = splitKey(line);
              return (
                <m.div
                  key={`${line}-${i}`}
                  className="flex gap-3 font-mono text-[11px] leading-[1.75]"
                  {...reveal(LEAD + 0.1 + i * STEP, reduceMotion)}
                >
                  {pair ? (
                    <>
                      <span className="text-muted-foreground/45 w-[5rem] shrink-0">{pair.key}</span>
                      <span className="text-foreground/90 min-w-0 flex-1 truncate">
                        {pair.value}
                      </span>
                    </>
                  ) : (
                    <span className="text-muted-foreground/50 min-w-0 flex-1 truncate pl-[6rem]">
                      {line.trim()}
                    </span>
                  )}
                </m.div>
              );
            })}
          </div>

          {/* the prompt */}
          <div className="flex flex-col gap-2 px-5 py-4">
            {BODY.map((line, i) => (
              <m.p
                key={`${line}-${i}`}
                className={
                  i === 0
                    ? 'text-foreground text-[13px] leading-snug font-medium text-pretty'
                    : 'text-muted-foreground/60 text-[12.5px] leading-snug text-pretty'
                }
                {...reveal(LEAD + 0.1 + (FRONTMATTER.length + i) * STEP, reduceMotion)}
              >
                {line.replace(/\*\*/g, '')}
              </m.p>
            ))}
          </div>
        </m.div>
      </div>
    </div>
  );
}

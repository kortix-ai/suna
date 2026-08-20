'use client';

import { cn } from '@/lib/utils';
import { m, useReducedMotion } from 'motion/react';
import type { ReactNode } from 'react';

/**
 * `/agent-computer` hero scene — the machine, drawn as a machine.
 *
 * A monitor on its stand with one session's workspace on the screen: the repo
 * in the sidebar, `kortix.yaml` open, a shell at the bottom. Nothing else. The
 * page claims every session gets its own computer, so the visual is that
 * computer rather than a diagram about it.
 *
 * Every string on the screen already ships elsewhere on this page — the tree is
 * `files.tree`, the YAML is the snippet the boot section renders. This page
 * carries an explicit accuracy gate, so nothing here is invented.
 *
 * MOTION — one pass on mount, then rest. The caret is the only exception, and
 * it is a shell idiom carrying real meaning.
 */

const EASE_OUT = [0.23, 1, 0.32, 1] as const;

/** The repo the machine cloned — `files.tree`, verbatim. */
const TREE = [
  { path: 'your-company/', depth: 0, open: false },
  { path: 'kortix.yaml', depth: 1, open: true },
  { path: '.kortix/opencode/', depth: 1, open: false },
  { path: 'agents/', depth: 2, open: false },
  { path: 'skills/', depth: 2, open: false },
  { path: 'commands/', depth: 2, open: false },
  { path: 'plugins/', depth: 2, open: false },
] as const;

/** The open file — the real `kortix.yaml` snippet from the boot section. */
const YAML = [
  '# the machine every session of this project boots',
  'kortix_version: 2',
  'runtime: opencode',
  '',
  'sandbox:',
  '  default: python',
  '  templates:',
  '    - slug: python',
  '      image: python:3.12-slim',
] as const;

function reveal(delay: number, reduceMotion: boolean) {
  return {
    initial: reduceMotion ? false : { opacity: 0, y: 6 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.32, delay, ease: EASE_OUT },
  } as const;
}

function YamlLine({ line }: { line: string }): ReactNode {
  if (line.startsWith('#')) return <span className="text-muted-foreground/40">{line}</span>;

  const match = /^(\s*(?:- )?)([\w.-]+)(:)(.*)$/.exec(line);
  if (!match) return <span className="text-muted-foreground/65">{line || ' '}</span>;

  const [, indent, key, colon, rest] = match;
  return (
    <>
      <span>{indent}</span>
      <span className="text-foreground/90">{key}</span>
      <span className="text-muted-foreground/40">{colon}</span>
      <span className="text-muted-foreground/70">{rest}</span>
    </>
  );
}

export function AgentComputerHeroVisual(): ReactNode {
  const reduceMotion = useReducedMotion() ?? false;

  return (
    <div
      className="flex w-full items-center justify-center"
      role="img"
      aria-label="A monitor showing one session's workspace: the project repo, kortix.yaml open, and a shell."
    >
      <m.div
        className="flex w-full max-w-[38rem] flex-col items-center"
        initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 14, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.46, ease: EASE_OUT }}
      >
        {/* ── bezel ───────────────────────────────────────────────────── */}
        <div className="border-border/70 bg-card/90 w-full rounded-xl border p-2 shadow-2xl backdrop-blur-xl sm:p-2.5">
          <div className="border-border/60 bg-background relative aspect-[16/10] w-full overflow-hidden rounded-md border">
            <div className="flex h-full flex-col">
              {/* title bar */}
              <div className="border-border/50 flex shrink-0 items-center justify-between gap-3 border-b px-3.5 py-2">
                <m.span
                  className="text-muted-foreground/70 font-mono text-[11px]"
                  {...reveal(0.18, reduceMotion)}
                >
                  /workspace
                </m.span>
                <m.span
                  className="text-muted-foreground/45 flex items-center gap-1.5 font-mono text-[10px] tracking-widest uppercase"
                  {...reveal(0.22, reduceMotion)}
                >
                  <span className="bg-foreground/60 size-1.5 rounded-full" />
                  session
                </m.span>
              </div>

              <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,0.62fr)_minmax(0,1fr)]">
                {/* sidebar — the repo */}
                <div className="border-border/50 flex flex-col gap-1.5 overflow-hidden border-r px-3 py-3">
                  {TREE.map((entry, i) => (
                    <m.span
                      key={entry.path}
                      className={cn(
                        'truncate rounded-[3px] px-1.5 py-0.5 font-mono text-[11px]',
                        entry.open
                          ? 'text-foreground bg-foreground/[0.07]'
                          : entry.depth === 0
                            ? 'text-foreground/80'
                            : 'text-muted-foreground/60',
                      )}
                      style={{ marginLeft: `${entry.depth * 0.55}rem` }}
                      {...reveal(0.24 + i * 0.04, reduceMotion)}
                    >
                      {entry.path}
                    </m.span>
                  ))}
                </div>

                {/* editor — the open file */}
                <div className="flex min-w-0 flex-col overflow-hidden">
                  <m.div
                    className="border-border/50 flex shrink-0 items-center border-b"
                    {...reveal(0.26, reduceMotion)}
                  >
                    <span className="border-border/50 text-foreground/85 border-r px-3 py-1.5 font-mono text-[11px]">
                      kortix.yaml
                    </span>
                  </m.div>

                  <div className="min-h-0 flex-1 overflow-hidden py-2.5">
                    {YAML.map((line, i) => (
                      <m.div
                        key={i}
                        className="flex items-start gap-3 px-3 font-mono text-[11px] leading-[1.55] whitespace-pre"
                        {...reveal(0.3 + i * 0.04, reduceMotion)}
                      >
                        <span className="text-muted-foreground/25 w-3 shrink-0 text-right tabular-nums select-none">
                          {i + 1}
                        </span>
                        <span className="truncate">
                          <YamlLine line={line} />
                        </span>
                      </m.div>
                    ))}
                  </div>
                </div>
              </div>

              {/* shell */}
              <m.div
                className="border-border/50 flex shrink-0 items-center gap-2 border-t px-3.5 py-2 font-mono text-[11px]"
                {...reveal(0.66, reduceMotion)}
              >
                <span className="text-foreground">$</span>
                <span className="text-muted-foreground/60">kortix</span>
                <span
                  className={cn(
                    'bg-foreground inline-block h-3 w-[0.35rem]',
                    !reduceMotion && 'animate-blink-cursor',
                  )}
                />
              </m.div>
            </div>
          </div>
        </div>
      </m.div>
    </div>
  );
}

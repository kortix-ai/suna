'use client';

import { MANIFEST } from '@/features/marketing/framework/content';
import { cn } from '@kortix/ui';
import { PauseIcon, PlayIcon } from '@phosphor-icons/react';
import { useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';

import { CustomizeBoard, type CustomizeTab } from './customize-board';
import { FrameworkWindow, type FrameworkFocus } from './framework-window';
import { H, SessionWindow, W } from './session-window';
import { ShareScene } from './share-scene';

/** The 1-based line range of a top-level kortix.yaml block, up to the next top-level key. */
function block(key: string): FrameworkFocus {
  const lines: readonly string[] = MANIFEST;
  const from = lines.indexOf(`${key}:`);
  let to = lines.findIndex((line, i) => i > from && /^[a-z]/.test(line));
  if (to < 0) to = lines.length;
  while (!lines[to - 1]?.trim()) to--;
  return { file: 'kortix.yaml', from: from + 1, to };
}

const LAST_TRIGGER = MANIFEST.indexOf('  - slug: weekly-post') + 1;

type Layer = 'session' | 'customize' | 'share' | 'framework';
type Step = { label: string; layer: Layer; tab?: CustomizeTab; focus?: FrameworkFocus };

/** Two modes, four steps each, played in one loop of eight. */
const MODES: { label: string; steps: Step[] }[] = [
  {
    label: 'Workspace',
    steps: [
      { label: 'Describe your goal', layer: 'session' },
      { label: 'Connect your tools', layer: 'customize', tab: 'Connectors' },
      { label: 'Automate work 24/7', layer: 'customize', tab: 'Triggers' },
      { label: 'Share with your team', layer: 'share' },
    ],
  },
  {
    label: 'Framework',
    steps: [
      { label: 'Agents as code', layer: 'framework', focus: block('agents') },
      { label: 'Connectors and policies', layer: 'framework', focus: block('connectors') },
      { label: 'Triggers run 24/7', layer: 'framework', focus: block('triggers') },
      {
        label: 'Ship and review',
        layer: 'framework',
        focus: { file: 'kortix.yaml', from: LAST_TRIGGER, to: MANIFEST.length },
      },
    ],
  },
];

const PER_MODE = 4;
const TOTAL = MODES.length * PER_MODE;
const LAYERS: Layer[] = ['session', 'customize', 'share', 'framework'];
/** How long each step shows, in ms. The longest scene (the session) needs ~5 s of it. */
const STEP_MS = 7500;

const stepAt = (index: number) => MODES[Math.floor(index / PER_MODE)].steps[index % PER_MODE];

/**
 * The hero walkthrough, built as a video player: one 16:9 stage and one
 * control bar under it, in a single frame. The bar holds the mode switch
 * (Workspace | Framework), the four chapters of the mode, and pause. The
 * active chapter's top edge is the timeline, on the seam with the stage.
 *
 * Each step is a short scene that plays from its start every time it shows:
 * the prompt typed and sent, a connector connected and a rule set to Ask, a
 * trigger added and fired, the session shared with a group and a person, a
 * kortix.yaml block in focus, `kortix ship` printing. One Arcadia project
 * throughout. Nothing plays or advances until 60% of the player is in view.
 * Pause, or opening a file in the framework view, holds the step. Reduced
 * motion: no auto-advance, no timeline, every scene in its final state.
 */
export function WorkspaceFramework() {
  const [index, setIndex] = useState(0);
  // A layer remounts each time it becomes the shown one, so its scene starts over.
  const [entries, setEntries] = useState<Record<Layer, number>>({
    session: 0,
    customize: 0,
    share: 0,
    framework: 0,
  });
  const [paused, setPaused] = useState(false);
  const [inView, setInView] = useState(false);
  const reduced = Boolean(useReducedMotion());
  const root = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLSpanElement>(null);
  const timer = useRef<Animation | null>(null);

  const mode = Math.floor(index / PER_MODE);
  const step = index % PER_MODE;
  const current = stepAt(index);

  const go = (next: number) => {
    const layer = stepAt(next).layer;
    if (layer !== current.layer) setEntries((e) => ({ ...e, [layer]: e[layer] + 1 }));
    setIndex(next);
  };

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => setInView(Boolean(entry?.isIntersecting)), {
      threshold: 0.6,
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // The line is the timer: when its fill finishes, the next step shows.
  useEffect(() => {
    const el = bar.current;
    if (!el || reduced) return;
    const fill = el.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], {
      duration: STEP_MS,
      easing: 'linear',
      fill: 'forwards',
    });
    fill.pause();
    fill.onfinish = () => go((index + 1) % TOTAL);
    timer.current = fill;
    return () => fill.cancel();
    // `go` reads `current`, which `index` already pins.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, reduced]);

  // Runs after the effect above, so a step picked while paused stays paused.
  useEffect(() => {
    if (paused || !inView) timer.current?.pause();
    else timer.current?.play();
  }, [paused, inView, index, reduced]);

  const playing = inView;

  return (
    <div
      ref={root}
      className="bg-background/20 ring-border w-full rounded-2xl p-1.5 ring-1 sm:p-2"
      role="region"
      aria-roledescription="walkthrough"
      aria-label={`Kortix ${MODES[mode].label.toLowerCase()}: ${current.label}`}
    >
      <div className="bg-background overflow-hidden rounded-xl border">
        {/* The stage: every layer stays mounted, the shown one fades in. */}
        <div className="relative w-full" style={{ aspectRatio: `${W} / ${H}` }}>
          {LAYERS.map((layer) => {
            const shown = current.layer === layer;
            return (
              <div
                key={`${layer}-${entries[layer]}`}
                inert={!shown}
                className={cn(
                  'duration-slower absolute inset-0 transition-opacity ease-out',
                  shown ? 'opacity-100' : 'pointer-events-none opacity-0',
                )}
              >
                {layer === 'session' ? (
                  <SessionWindow framed={false} play={shown && playing} />
                ) : null}
                {layer === 'customize' ? (
                  <CustomizeBoard tab={current.tab ?? 'Connectors'} play={shown && playing} />
                ) : null}
                {layer === 'share' ? <ShareScene play={shown && playing} /> : null}
                {layer === 'framework' ? (
                  <FrameworkWindow
                    focus={shown ? current.focus : undefined}
                    shipped={shown && index === TOTAL - 1}
                    onInteract={() => setPaused(true)}
                  />
                ) : null}
              </div>
            );
          })}
        </div>

        {/* The control bar, joined to the stage by one hairline. Below 64rem
            the chapters not playing show their number only. */}
        <div className="@container flex flex-wrap border-t sm:flex-nowrap">
          {/* The mode switch: two quiet text tabs, the bar's first cell. */}
          <div
            role="group"
            aria-label="View"
            className="flex basis-full items-center justify-center gap-4 border-b px-4 sm:basis-auto sm:border-r sm:border-b-0"
          >
            {MODES.map((m, i) => (
              <button
                key={m.label}
                type="button"
                aria-pressed={mode === i}
                onClick={() => go(i * PER_MODE)}
                className="text-muted-foreground hover:text-foreground aria-pressed:text-foreground outline-ring flex h-10 items-center rounded-sm text-sm font-medium transition-colors focus-visible:outline-2 sm:h-auto"
              >
                {m.label}
              </button>
            ))}
          </div>

          <ol
            aria-label={`${MODES[mode].label} steps`}
            className="flex min-w-0 grow basis-4/5 sm:flex-1"
          >
            {MODES[mode].steps.map((s, i) => {
              const active = i === step;
              return (
                <li
                  key={s.label}
                  className={cn(
                    'relative flex min-w-0 border-r last:border-r-0',
                    active ? 'flex-[3] @5xl:flex-1' : 'flex-1',
                  )}
                >
                  <button
                    type="button"
                    aria-current={active ? 'step' : undefined}
                    onClick={() => go(mode * PER_MODE + i)}
                    className={cn(
                      'outline-ring hover:text-foreground flex min-w-0 flex-1 items-center gap-2.5 px-3 py-3 text-left text-sm transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 sm:px-4',
                      active ? 'text-foreground' : 'text-muted-foreground',
                    )}
                  >
                    <span className="text-muted-foreground font-mono text-xs tabular-nums">
                      {i + 1}
                    </span>
                    <span className={cn('truncate', !active && 'hidden @5xl:inline')}>
                      {s.label}
                    </span>
                  </button>
                  {active ? (
                    <span aria-hidden className="absolute inset-x-0 -top-px h-0.5 overflow-hidden">
                      <span
                        ref={bar}
                        className="bg-foreground block size-full origin-left"
                        style={{ transform: reduced ? 'scaleX(1)' : 'scaleX(0)' }}
                      />
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ol>

          {reduced ? null : (
            <button
              type="button"
              onClick={() => setPaused(!paused)}
              aria-label={paused ? 'Play' : 'Pause'}
              className="text-muted-foreground hover:text-foreground outline-ring flex w-11 shrink-0 items-center justify-center border-l transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2"
            >
              {paused ? (
                <PlayIcon weight="fill" className="size-3" />
              ) : (
                <PauseIcon weight="fill" className="size-3" />
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

'use client';

import { cn } from '@/lib/utils';
import {
  m,
  useScroll,
  useSpring,
  useTransform,
  useInView,
  useMotionValueEvent,
  useReducedMotion,
  type MotionValue,
} from 'motion/react';
import { useEffect, useId, useRef, useState } from 'react';
import type { ThesisStatement } from './content';
import { useDevelopersCopy } from './use-developers-copy';
import { SECTION_HEADING } from './shared';

type Statement = ThesisStatement;

const lineClass = SECTION_HEADING;

function Proof({ s, className }: { s: Statement; className?: string }) {
  return (
    <div className={className}>
      <p className="text-foreground text-lg text-pretty">{s.body}</p>
      <div className="mt-6">
        {s.steps && <Timeline steps={s.steps} />}
        {s.diff?.file && <Diff file={s.diff.file} lines={s.diff.lines ?? []} />}
        {s.hosts?.from && <Hosts from={s.hosts.from} to={s.hosts.to ?? ''} />}
      </div>
    </div>
  );
}

/**
 * A session's life, played once when it scrolls into view: boot → line → agent works → line →
 * change request (busy blue ring) → ~1.2s later it lands solid blue and a green line runs to merge.
 * Phase n reveals everything whose `at` ≤ n. Reduced motion skips straight to the final phase.
 */
// Each line draws for LINE_S; the next step starts landing just before the line arrives.
const PHASE_MS = [400, 900, 1600, 2300, 3000, 4200, 4900];
const LINE_S = 0.9;
const STEP_AT = [1, 3, 5, 7];
const LINE_AT = [2, 4, 6];
const EASE_OUT = [0.23, 1, 0.32, 1] as const;
const EASE_IN_OUT = [0.65, 0, 0.35, 1] as const;

function Timeline({ steps }: { steps: { title: string; detail: string }[] }) {
  const ref = useRef<HTMLOListElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.6 });
  const reduce = useReducedMotion();
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    if (!inView || reduce) return;
    const timers = PHASE_MS.map((ms, i) => setTimeout(() => setPhase(i + 1), ms));
    return () => timers.forEach(clearTimeout);
  }, [inView, reduce]);

  const p = reduce ? PHASE_MS.length : phase;
  const busy = p >= STEP_AT[2] && p < LINE_AT[2];

  return (
    <ol ref={ref}>
      {steps.map((step, i) => {
        const shown = p >= STEP_AT[i];
        const last = i === steps.length - 1;
        return (
          <li key={step.title} className="flex gap-3.5">
            <div className="flex flex-col items-center">
              <m.span
                initial={false}
                animate={{
                  opacity: shown ? 1 : 0,
                  scale: shown ? 1 : 0.6,
                  filter: shown || reduce ? 'blur(0px)' : 'blur(3px)',
                }}
                transition={{ duration: 0.6, ease: EASE_OUT }}
                style={{ transition: 'background-color 500ms ease, border-color 500ms ease' }}
                className={cn(
                  'relative mt-1 size-2.5 shrink-0 rounded-full',
                  i < 2 && 'bg-foreground',
                  i === 2 &&
                    (busy ? 'border-kortix-base bg-background border-2' : 'bg-kortix-base'),
                  last && 'bg-kortix-green',
                )}
              >
                {i === 2 && busy && (
                  <m.span
                    aria-hidden
                    className="border-kortix-base absolute -inset-0.5 rounded-full border"
                    animate={{ opacity: [0.6, 0], scale: [1, 2] }}
                    transition={{ duration: 1.4, ease: 'easeOut', repeat: Infinity }}
                  />
                )}
              </m.span>
              {!last && (
                <span className="relative w-px flex-1">
                  <m.span
                    initial={false}
                    animate={{ scaleY: p >= LINE_AT[i] ? 1 : 0 }}
                    transition={{ duration: reduce ? 0 : LINE_S, ease: EASE_IN_OUT }}
                    className={cn(
                      'absolute inset-0 origin-top',
                      i === 2 ? 'bg-kortix-green' : 'bg-foreground',
                    )}
                  />
                </span>
              )}
            </div>
            <m.div
              initial={false}
              animate={{
                opacity: shown ? 1 : 0,
                y: shown || reduce ? 0 : 6,
                filter: shown || reduce ? 'blur(0px)' : 'blur(6px)',
              }}
              transition={{ duration: 0.7, ease: EASE_OUT, delay: shown ? 0.08 : 0 }}
              className={cn('flex flex-col gap-0.5', !last && 'pb-5')}
            >
              <span className="text-foreground text-sm font-medium">{step.title}</span>
              <span className="text-muted-foreground font-mono text-xs">{step.detail}</span>
            </m.div>
          </li>
        );
      })}
    </ol>
  );
}

function Diff({ file, lines }: { file: string; lines: readonly string[] }) {
  return (
    <div className="border-border bg-card overflow-hidden rounded-lg border">
      <div className="border-border flex items-center justify-between gap-4 border-b px-4 py-3 font-mono text-sm">
        <span className="text-foreground truncate">{file}</span>
        <span className="flex shrink-0 gap-2 text-xs">
          <span className="text-kortix-green">+1</span>
          <span className="text-kortix-red">−1</span>
        </span>
      </div>
      {/* No overflow scroller: it would be a keyboard focus trap on dimmed proofs. */}
      <pre className="py-2 font-mono text-sm leading-relaxed break-words whitespace-pre-wrap">
        {lines.map((line) => (
          <span
            key={line}
            className={cn(
              'block px-4',
              line.startsWith('-') && 'bg-kortix-red/15 text-kortix-red',
              line.startsWith('+') && 'bg-kortix-green/15 text-kortix-green',
              line.startsWith(' ') && 'text-muted-foreground',
            )}
          >
            {line}
          </span>
        ))}
      </pre>
    </div>
  );
}

/** Kortix Cloud → your servers, drawn in dot halftone so it matches the page's halftone art. */
function Hosts({ from, to }: { from: string; to: string }) {
  const dots = useId();
  const lines = useId();
  const shimmer = useId();
  const reduce = useReducedMotion();
  return (
    <div className="bg-muted text-foreground flex items-center justify-center rounded-lg px-4 py-10">
      <svg viewBox="0 0 440 200" fill="none" aria-hidden className="w-full max-w-lg">
        <defs>
          <pattern id={dots} width="5" height="5" patternUnits="userSpaceOnUse">
            <circle cx="2.5" cy="2.5" r="1.1" fill="currentColor" />
          </pattern>
          {/* currentColor in stops resolves on the gradient element, so the accent goes here. */}
          <m.linearGradient
            id={shimmer}
            className="text-kortix-base"
            gradientUnits="userSpaceOnUse"
            y1="0"
            y2="0"
            initial={{ x1: 190, x2: 230 }}
            animate={reduce ? undefined : { x1: [190, 270], x2: [230, 310] }}
            transition={{ duration: 1.6, ease: 'linear', repeat: Infinity, repeatDelay: 0.4 }}
          >
            <stop offset="0" stopColor="currentColor" stopOpacity="0.35" />
            <stop offset="0.5" stopColor="currentColor" stopOpacity="1" />
            <stop offset="1" stopColor="currentColor" stopOpacity="0.35" />
          </m.linearGradient>
          <pattern id={lines} width="4" height="4" patternUnits="userSpaceOnUse">
            <rect y="1.4" width="4" height="1.2" fill="currentColor" />
          </pattern>
        </defs>
        <path
          d="M40 120a30 30 0 0 1 20-52a40 40 0 0 1 76-6a28 28 0 0 1 34 30a26 26 0 0 1-6 52H56a24 24 0 0 1-16-24Z"
          fill={`url(#${dots})`}
          opacity="0.45"
        />
        {/* Dotted arrow with a shimmer band sweeping left → right, forever (static under reduced motion). */}
        <g
          stroke={`url(#${shimmer})`}
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray="0 5"
        >
          <path d="M222 100H266" />
          <path d="M259 93L266 100L259 107" />
        </g>
        {/* Isometric server from Paper (H6): dotted top, hatched left face, dotted right face. */}
        <g transform="translate(40 -40)">
          <path d="M250 110L310 80 370 110 310 140Z" fill={`url(#${dots})`} opacity="0.7" />
          <path d="M250 110L310 140 310 190 250 160Z" fill={`url(#${lines})`} />
          <path d="M370 110L310 140 310 190 370 160Z" fill={`url(#${dots})`} />
        </g>
        <g className="font-mono" fontSize="12" textAnchor="middle">
          <text x="115" y="190" className="fill-muted-foreground">
            {from}
          </text>
          <text x="350" y="190" fill="currentColor">
            {to}
          </text>
        </g>
      </svg>
    </div>
  );
}

/** Below lg and under reduced motion: every statement in full ink, each followed by its proof. */
function Stacked() {
  const { thesis } = useDevelopersCopy();
  return (
    <div className="flex flex-col gap-12 sm:gap-16 lg:motion-reduce:grid lg:motion-reduce:grid-cols-12 lg:motion-reduce:gap-x-12">
      {thesis.statements.map((s, i) => (
        <div key={s.line} className="lg:motion-reduce:contents">
          <h2 className={cn(lineClass, 'lg:motion-reduce:col-span-6')}>{s.line}</h2>
          <Proof
            s={s}
            className="mt-6 lg:motion-reduce:col-span-6 lg:motion-reduce:mt-0"
          />
        </div>
      ))}
    </div>
  );
}

/**
 * Scroll-linked, not state-switched: each statement's opacity and its proof's fade/rise are
 * continuous functions of a spring-smoothed scroll progress, so fast scrolling never snaps.
 */
function PinnedLine({
  s,
  index,
  progress,
}: {
  s: Statement;
  index: number;
  progress: MotionValue<number>;
}) {
  const { thesis } = useDevelopersCopy();
  const n = thesis.statements.length;
  // Snap stops sit at progress i / (n - 1); each line is full ink at its stop.
  const center = index / (n - 1);
  const half = 0.5 / (n - 1);
  const opacity = useTransform(progress, [center - half * 2, center, center + half * 2], [0.2, 1, 0.2]);
  return (
    <m.h2 style={{ opacity }} className={lineClass}>
      {s.line}
    </m.h2>
  );
}

/**
 * One proof at a time, picked by the snap stop. Proofs move with the scroll direction: the
 * outgoing one slides up and out, the incoming one rises from below (reversed when scrolling up).
 */
function PinnedProof({ s, offset }: { s: Statement; offset: number }) {
  const active = offset === 0;
  return (
    <m.div
      initial={false}
      animate={{
        opacity: active ? 1 : 0,
        y: active ? 0 : offset > 0 ? 48 : -48,
        filter: active ? 'blur(0px)' : 'blur(6px)',
      }}
      transition={{ duration: 0.6, ease: [0.77, 0, 0.175, 1] }}
      aria-hidden={!active}
      className={cn('col-start-1 row-start-1', !active && 'pointer-events-none')}
    >
      <Proof s={s} />
    </m.div>
  );
}

/** lg+: 300vh section with a sticky inner block. */
function Pinned() {
  const { thesis } = useDevelopersCopy();
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start start', 'end end'] });
  // Light spring: smooths wheel/trackpad bursts without feeling laggy.
  const progress = useSpring(scrollYProgress, { stiffness: 300, damping: 40, mass: 0.3 });
  const n = thesis.statements.length;
  const [active, setActive] = useState(0);
  useMotionValueEvent(scrollYProgress, 'change', (v) =>
    setActive(Math.min(n - 1, Math.max(0, Math.round(v * (n - 1))))),
  );

  // Proximity snap on the page while this section is mounted: a scroll that ends near a stop
  // settles on it. Proximity (not mandatory) never traps the reader outside the section.
  useEffect(() => {
    const root = document.documentElement;
    const prev = root.style.scrollSnapType;
    root.style.scrollSnapType = 'y proximity';
    return () => {
      root.style.scrollSnapType = prev;
    };
  }, []);

  return (
    <div ref={ref} className="relative h-[300vh]">
      {/* One snap stop per statement, one viewport apart. */}
      {thesis.statements.map((s, i) => (
        <div
          key={s.line}
          aria-hidden
          style={{ top: `${i * 100}vh` }}
          className="pointer-events-none absolute inset-x-0 h-screen snap-start"
        />
      ))}
      <div className="sticky top-0 flex h-screen items-center">
        <div className="mx-auto w-full max-w-7xl px-6">
          <div className="mt-10 grid grid-cols-12 items-center gap-x-12">
            <div className="col-span-6 flex flex-col gap-3">
              {thesis.statements.map((s, i) => (
                <PinnedLine key={s.line} s={s} index={i} progress={progress} />
              ))}
            </div>
            <div className="col-span-6 grid">
              {thesis.statements.map((s, i) => (
                <PinnedProof key={s.line} s={s} offset={i - active} />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function DevelopersThesis() {
  return (
    <section id="thesis" className="relative w-full">
      {/* Pinned: lg+ with motion allowed. Stacked: everything else. Pure CSS switch. */}
      <div className="hidden lg:block motion-reduce:lg:hidden">
        <Pinned />
      </div>
      <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 sm:py-24 md:py-30 lg:hidden motion-reduce:lg:block">
        <div className="mt-10">
          <Stacked />
        </div>
      </div>
    </section>
  );
}

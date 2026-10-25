'use client';

import { Claude } from '@kortix/ui/internal/icons/claude';
import { Gemini } from '@/features/icon/icons/gemini';
import { OpenAI } from '@kortix/ui/internal/icons/open-ai';
import { GlobeIcon } from '@phosphor-icons/react';
import { AnimatePresence, m, useReducedMotion } from 'motion/react';
import { useLocalizedUiCatalog } from '@kortix/ui/i18n';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@kortix/ui';
import { SandGlobe } from './sand-globe';

/**
 * Layer 03 — the model is a SLOT, and the slot is yours.
 *
 * THE FORM, AND WHY IT IS THIS ONE
 *
 * Every panel in this section had to find a shape native to its own claim, and
 * no two may share one — the section reads as a single argument, and an
 * argument made six times in the same diagram is a template. Taken already:
 * `source-of-truth` is a schematic, `connectors` is a wall of tiles, `computer`
 * is a chat transcript, `control-plane` is a review queue. So this is none of
 * those. It is a CONTROL.
 *
 * That is not a stylistic dodge, it is the honest reading of the layer. The
 * claim here is not "we integrate with these vendors" — every tool says that,
 * and a list is how every tool says it. The claim is that the model is one
 * field with a value in it, that the value is swappable per agent, per session,
 * per message, and that swapping it costs you nothing because the key was never
 * ours to begin with. A field with a value in it is a control. So the panel is
 * the control, at rest, changing its own value while you watch.
 *
 * The motion carries the whole argument and there is very little of it: the
 * indicator slides, the value swaps. Two moving things. A reader who looks away
 * and back has lost nothing, which is the test an ambient loop has to pass.
 *
 * ACCURACY GATE — checked against shipped code, not the manifesto:
 *   - The custom-provider form takes any base URL and drives it through
 *     `@ai-sdk/openai-compatible`, which is why vLLM / LiteLLM / Ollama are ONE
 *     entry and not three logos we do not integrate with.
 *   - The ChatGPT row is the Codex device-grant OAuth
 *     (`apps/api/src/projects/codex-device-auth.ts`) and is real. Cursor is NOT
 *     — there is no Cursor auth path anywhere in the codebase, however often a
 *     README says otherwise. Never add it.
 *   - Model FAMILIES only, never version numbers. This panel has no build step
 *     that would catch a stale one, and a marketing page naming `opus-4.7` is
 *     wrong within the month.
 *   - The value only ever settles on a CONNECTED provider. Showing a session
 *     resolved to an endpoint nobody has wired up animates a claim the demo has
 *     not earned.
 */

type Glyph = (props: { className?: string }) => ReactNode;

const PROVIDERS: {
  id: string;
  glyph: Glyph;
  name: string;
  models: string;
  /** Values the slot may settle on. An unwired provider gets no traffic. */
  connected: boolean;
}[] = [
  {
    id: 'anthropic',
    glyph: Claude as Glyph,
    name: 'Anthropic',
    models: 'Opus · Sonnet · Haiku',
    connected: true,
  },
  { id: 'openai', glyph: OpenAI as Glyph, name: 'OpenAI', models: 'GPT · Codex', connected: true },
  {
    id: 'google',
    glyph: Gemini as Glyph,
    name: 'Google',
    models: 'Gemini Pro · Flash',
    connected: true,
  },
  {
    id: 'custom',
    glyph: GlobeIcon as Glyph,
    name: 'Your endpoint',
    models: 'anything OpenAI-compatible',
    connected: false,
  },
];

/** How long the slot rests on each provider. Slow on purpose: this is a value
 *  settling, not a spinner. Anything under ~1.5s reads as loading. */
const DWELL_MS = 2200;

/**
 * The swap, at the exact values the design system specifies for a contextual
 * icon change: scale 0.25 → 1, opacity 0 → 1, blur 4px → 0, on a spring with
 * `bounce: 0`. Blur is what bridges two overlapping states into one perceived
 * transformation rather than two objects trading places — without it, a
 * crossfade at this size reads as a flicker no easing can fix.
 */
const SWAP = { type: 'spring', duration: 0.3, bounce: 0 } as const;
const SWAP_OUT = { opacity: 0, scale: 0.25, filter: 'blur(4px)' };
const SWAP_IN = { opacity: 1, scale: 1, filter: 'blur(0px)' };

/** The value's own entrance is gentler — text at 20px does not survive being
 *  scaled from a quarter, so it rises and resolves instead. */
const RISE_OUT = { opacity: 0, y: -10, filter: 'blur(4px)' };
const RISE_FROM = { opacity: 0, y: 10, filter: 'blur(4px)' };
const RISE_IN = { opacity: 1, y: 0, filter: 'blur(0px)' };

/**
 * Reveal once, cycle only while on screen.
 *
 * `drawn` LATCHES so the panel builds itself a single time. `visible` does not,
 * because the cycle is an interval, and an interval still firing for a panel
 * nobody is looking at is a timer leak with a repaint attached to it.
 */
function usePanelActivity() {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [drawn, setDrawn] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        setVisible(entry.isIntersecting);
        if (entry.isIntersecting) setDrawn(true);
      },
      { threshold: 0.3 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return { ref, visible, drawn };
}

/** One cell of the spec strip: a mono label over its value. */
function SpecCell({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        'border-border flex min-w-0 flex-col justify-center gap-0.5 border-r px-4 py-3',
        className,
      )}
    >
      <span className="text-muted-foreground font-mono text-xs tracking-wide uppercase">
        {label}
      </span>
      <span className="relative block h-6 min-w-0 overflow-hidden">{children}</span>
    </span>
  );
}

export function StepModels(): ReactNode {
  const providers = useLocalizedUiCatalog(PROVIDERS);
  const routable = providers.filter((provider) => provider.connected);
  const reduced = useReducedMotion();
  const { ref, visible, drawn } = usePanelActivity();
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (!visible || reduced) return;
    const id = setInterval(() => setIndex((i) => (i + 1) % routable.length), DWELL_MS);
    return () => clearInterval(id);
  }, [visible, reduced, routable.length]);

  const active = routable[index] ?? routable[0];
  const Glyph = active.glyph;

  /** The panel's own entrance. Three bands, 70ms apart, opacity-only under
   *  reduced motion. */
  const band = (order: number) => ({
    initial: reduced ? { opacity: 0 } : { opacity: 0, y: 8 },
    animate: drawn ? { opacity: 1, y: 0 } : reduced ? { opacity: 0 } : { opacity: 0, y: 8 },
    transition: {
      duration: 0.4,
      ease: [0.23, 1, 0.32, 1] as [number, number, number, number],
      delay: reduced ? 0 : order * 0.07,
    },
  });

  return (
    <div ref={ref} className="relative h-full min-h-0 w-full">
      {/* The sand globe (fourier-series studio), unframed: it runs past the
          frame's padding at the sides and top, and stops where the slot card
          starts, so the globe sits above the card and never under it. The
          bottom edge is the card's top (the card sits on the bottom edge, ~65px tall);
          the top edge moves up by the same amount, so the layer keeps its
          original height and the globe its original size.
          Each model gets its own spherical harmonic: when the slot moves to
          the next provider, the grains flow into a new pattern. */}
      <m.div
        {...band(0)}
        className="pointer-events-none absolute -inset-x-4 -top-38 bottom-14 sm:-inset-x-8 sm:-top-46 sm:bottom-10 lg:-inset-x-12 lg:-top-62 lg:bottom-6"
      >
        <SandGlobe mode={index} reduced={!!reduced} radius={0.46} />
      </m.div>

      {/* THE SLOT, as a spec strip: it runs past the panel's padding and sits
          flush on the panel's bottom edge, open at the foot like a tab. The
          mark in its own cell, then Provider,
          Models and Mode, each a mono label over its value, split by
          hairlines. Provider and Models move with the slot; Mode is `auto`
          and never moves. */}
      <m.div
        {...band(1)}
        className="border-border bg-background absolute inset-x-4 -bottom-4 flex items-stretch rounded-t-lg border border-b-0 sm:inset-x-8 sm:-bottom-8 lg:-bottom-12"
      >
        {/* Fixed-size boxes with their contents stacked inside, so the
            outgoing and incoming values overlap and blur into each other
            instead of reflowing the row. */}
        <span className="border-border relative flex w-14 shrink-0 items-center justify-center border-r">
          <AnimatePresence initial={false} mode="popLayout">
            <m.span
              key={active.id}
              initial={SWAP_OUT}
              animate={SWAP_IN}
              exit={SWAP_OUT}
              transition={SWAP}
              className="text-foreground absolute inset-0 flex items-center justify-center"
            >
              <Glyph className="size-5" />
            </m.span>
          </AnimatePresence>
        </span>

        <SpecCell label="Provider" className="flex-1">
          <AnimatePresence initial={false} mode="popLayout">
            <m.span
              key={active.id}
              initial={RISE_FROM}
              animate={RISE_IN}
              exit={RISE_OUT}
              transition={SWAP}
              className="text-foreground block truncate text-base font-medium"
            >
              {active.name}
            </m.span>
          </AnimatePresence>
        </SpecCell>

        <SpecCell label="Models" className="hidden flex-1 sm:flex">
          <AnimatePresence initial={false} mode="popLayout">
            <m.span
              key={active.id}
              initial={RISE_FROM}
              animate={RISE_IN}
              exit={RISE_OUT}
              transition={SWAP}
              className="text-foreground block truncate text-base"
            >
              {active.models}
            </m.span>
          </AnimatePresence>
        </SpecCell>

        {/* `auto` is the real default and it never changes: the value beside
            it moved and the session was never reconfigured once. */}
        <SpecCell label="Mode" className="w-24 shrink-0 border-r-0 sm:w-28">
          <span className="text-foreground block font-mono text-sm">auto</span>
        </SpecCell>
      </m.div>
    </div>
  );
}

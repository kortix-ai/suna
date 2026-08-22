'use client';

import { ChatGPT } from '@/features/icon/icons/chat-gpt';
import { Claude } from '@/features/icon/icons/claude';
import { Gemini } from '@/features/icon/icons/gemini';
import { Kortix } from '@/features/icon/icons/kortix';
import { OpenAI } from '@/features/icon/icons/open-ai';
import { cn } from '@/lib/utils';
import { GlobeIcon, KeyIcon } from '@phosphor-icons/react';
import { AnimatePresence, m, useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

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
 *   - The fourth row is BYOK through the Kortix gateway: any catalog provider
 *     with an API key (`provider-connect.tsx`, `LLM_PROVIDERS`), which is why
 *     the long tail is ONE entry and not a wall of logos. There is no custom
 *     base-URL form — OpenCode sees exactly one provider, `kortix`, and the
 *     gateway resolves the upstream from the models.dev catalog.
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
    id: 'byok',
    glyph: GlobeIcon as Glyph,
    name: 'Any provider',
    models: 'Grok · Mistral · DeepSeek · more',
    connected: false,
  },
];

/** Where the slot can be pinned. Three scopes, narrowest last. */
const SCOPES = ['per agent', 'per session', 'per message'];

/** How the model gets paid for. Three real paths, no aspirational fourth. */
const BILLING: { id: string; glyph: Glyph; label: string }[] = [
  { id: 'key', glyph: KeyIcon as Glyph, label: 'Your own API key' },
  { id: 'chatgpt', glyph: ChatGPT as Glyph, label: 'Your ChatGPT subscription' },
  { id: 'gateway', glyph: Kortix as Glyph, label: 'Kortix Gateway' },
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

const ROUTABLE = PROVIDERS.filter((provider) => provider.connected);

export function StepModels(): ReactNode {
  const reduced = useReducedMotion();
  const { ref, visible, drawn } = usePanelActivity();
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (!visible || reduced) return;
    const id = setInterval(() => setIndex((i) => (i + 1) % ROUTABLE.length), DWELL_MS);
    return () => clearInterval(id);
  }, [visible, reduced]);

  const active = ROUTABLE[index] ?? ROUTABLE[0];
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
    <div ref={ref} className="flex h-full min-h-0 w-full flex-col overflow-hidden">
      {/* ── The control (lg+, where the pinned pane gives it room) ────── */}
      <div className="hidden h-full flex-col justify-center gap-5 px-8 py-7 lg:flex">
        {/* The field's own label line. A rule between the name and the scopes,
            because that is how a form labels a field — and reading this panel
            as a form is the entire point. */}
        <m.div {...band(0)} className="flex items-center gap-3">
          <span className="text-muted-foreground font-mono text-[11px] tracking-wide">model</span>
          <span className="bg-border h-px flex-1" />
          <span className="text-muted-foreground/60 font-mono text-[11px] tracking-wide">
            {SCOPES.join(' · ')}
          </span>
        </m.div>

        {/* THE SLOT. One field, one value, and the value is what moves. */}
        <m.div
          {...band(1)}
          className="border-border bg-background flex items-center gap-4 rounded-lg border px-5 py-4"
        >
          {/* Both children are `relative` boxes of a fixed size with their
              contents absolutely stacked inside. That is what lets the outgoing
              and incoming states overlap and blur into each other instead of
              reflowing the row — a swap that changes its container's size is a
              swap the eye reads as two separate events. */}
          <span className="border-border bg-muted/50 relative flex size-16 shrink-0 items-center justify-center rounded-md border">
            <AnimatePresence initial={false} mode="popLayout">
              <m.span
                key={active.id}
                initial={SWAP_OUT}
                animate={SWAP_IN}
                exit={SWAP_OUT}
                transition={SWAP}
                className="text-foreground absolute inset-0 flex items-center justify-center"
              >
                <Glyph className="size-7" />
              </m.span>
            </AnimatePresence>
          </span>

          <span className="relative min-w-0 flex-1">
            <AnimatePresence initial={false} mode="popLayout">
              <m.span
                key={active.id}
                initial={RISE_FROM}
                animate={RISE_IN}
                exit={RISE_OUT}
                transition={SWAP}
                className="block min-w-0"
              >
                <span className="text-foreground block truncate text-xl leading-tight font-medium tracking-tight">
                  {active.name}
                </span>
                <span className="text-muted-foreground mt-1 block truncate text-[12.5px] leading-tight">
                  {active.models}
                </span>
              </m.span>
            </AnimatePresence>
          </span>

          {/* `auto` is the real default and it never changes — which is the
              quiet half of the claim. The value under it moved three times and
              the session was never reconfigured once. */}
          <span className="border-border bg-muted/40 text-muted-foreground shrink-0 rounded-full border px-2.5 py-1 font-mono text-[11px] leading-4">
            auto
          </span>
        </m.div>

        {/* The alternatives, as one segmented row. The indicator is a shared
            `layoutId`, so it TRAVELS between cells rather than fading out here
            and in there — the same primitive the section rail uses, and the
            reason the row reads as one control with a position instead of four
            independent chips taking turns lighting up. */}
        <m.div {...band(2)} className="grid grid-cols-4 gap-1.5">
          {PROVIDERS.map((provider) => {
            const isActive = provider.id === active.id;
            return (
              <div
                key={provider.id}
                className="relative flex items-center gap-2.5 rounded-md px-3 py-2.5"
              >
                {isActive && (
                  <m.span
                    layoutId="model-slot-indicator"
                    transition={{ type: 'spring', stiffness: 400, damping: 34 }}
                    className="border-foreground/15 bg-muted/60 absolute inset-0 rounded-md border"
                  />
                )}
                <span
                  className={cn(
                    'relative flex size-6 shrink-0 items-center justify-center transition-colors duration-300',
                    isActive ? 'text-foreground' : 'text-muted-foreground/60',
                  )}
                >
                  <provider.glyph className="size-4" />
                </span>
                <span className="relative min-w-0">
                  <span
                    className={cn(
                      'block truncate text-[12.5px] leading-tight font-medium transition-colors duration-300',
                      isActive ? 'text-foreground' : 'text-muted-foreground',
                    )}
                  >
                    {provider.name}
                  </span>
                  {/* Status lives here rather than as a coloured dot per row.
                      "Connected" is the boring case and three green dots in a
                      row is three pieces of decoration; the one row that says
                      something different is the one worth reading. */}
                  <span className="text-muted-foreground/60 block truncate text-[10.5px] leading-tight">
                    {provider.connected ? 'connected' : 'add yours'}
                  </span>
                </span>
              </div>
            );
          })}
        </m.div>

        {/* The second half of the claim: whatever fills the slot, the bill is
            still yours. Set as a sentence, not a table — three rows of chrome
            for three short phrases is a panel arguing with itself. */}
        <m.div {...band(3)} className="border-border flex items-center gap-3 border-t pt-4">
          <span className="text-muted-foreground/60 shrink-0 font-mono text-[11px] tracking-wide">
            billed through
          </span>
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
            {BILLING.map((option, i) => (
              <span key={option.id} className="flex items-center gap-2">
                {i > 0 && <span className="text-muted-foreground/30">·</span>}
                <span className="text-muted-foreground flex items-center gap-1.5 text-[12.5px]">
                  <option.glyph className="size-3.5 shrink-0" />
                  {option.label}
                </span>
              </span>
            ))}
          </span>
        </m.div>
      </div>

      {/* ── Below lg: the 256–304px frame cannot hold a hero field — same
          content, one column, no swap. ─────────────────────────────────── */}
      <div className="flex h-full flex-col justify-center gap-2 overflow-y-auto p-3 lg:hidden">
        <div className="border-border bg-background flex items-center gap-3 rounded-md border px-3 py-2.5">
          <span className="border-border bg-muted/50 text-foreground flex size-8 shrink-0 items-center justify-center rounded-sm border">
            <Claude className="size-4" />
          </span>
          <span className="min-w-0">
            <span className="text-foreground block font-mono text-[13px] leading-tight font-medium">
              model: auto
            </span>
            <span className="text-muted-foreground block text-[11px] leading-tight">
              {SCOPES.join(' · ')}
            </span>
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {PROVIDERS.map((provider) => (
            <div
              key={provider.id}
              className="border-border bg-background flex items-center gap-2.5 rounded-md border px-3 py-2"
            >
              <span className="text-muted-foreground flex size-5 shrink-0 items-center justify-center">
                <provider.glyph className="size-4" />
              </span>
              <span className="min-w-0">
                <span className="text-foreground block truncate text-[13px] leading-tight font-medium">
                  {provider.name}
                </span>
                <span className="text-muted-foreground block truncate text-[11px] leading-tight">
                  {provider.models}
                </span>
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

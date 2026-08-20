'use client';

import { RuntimeMark as OpenCode } from '@/features/icon/icons/open-code';
import { cn } from '@/lib/utils';
import { CheckIcon, ProhibitIcon } from '@phosphor-icons/react';
import { AnimatePresence, m, useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Layer 04 — what the harness adds, shown as the difference it makes.
 *
 * THE FORM, AND WHY IT IS THIS ONE
 *
 * The layer's own copy is already a comparison: "A model on its own answers.
 * The harness gives it planning, tool use and multi-step runs it actually
 * finishes." A sentence built on a contrast should not be illustrated with a
 * list — it should be illustrated with the contrast. So the panel is a diptych,
 * and both halves get the same request at the same moment.
 *
 * The left half produces sentences. The right half produces a merged change.
 * They run SIMULTANEOUSLY and finish at roughly the same time, which is the
 * only way the comparison is fair and the only way it lands: two panes, equal
 * seconds, and one of them moved the repo.
 *
 * This also had to be a shape no other panel in the section uses — the section
 * reads as one argument, and an argument made six times in the same diagram is
 * a template. Taken already: `source-of-truth` is a schematic, `connectors` is
 * a wall of tiles, `models` is a control, `computer` is a chat transcript,
 * `control-plane` is a review queue. A diptych is none of them.
 *
 * The run has a story rather than a sequence. It reads the file, patches it,
 * proves the patch, tries to push — and is REFUSED by a line in its own config
 * — then opens a change request instead. Planning, tool use, permission and the
 * hand-off to layer 06, in five rows, without a single one of those words
 * appearing as a bullet.
 *
 * ACCURACY GATE — every claim below is checkable in the product:
 *   - `permission.bash` as a glob map, with `git push: deny`, is the shape the
 *     v2 validator accepts, and `permission` is in `BEHAVIOR_FRONTMATTER_KEYS`
 *     (`apps/api/src/projects/lib/compile-agent-config.ts`). `tools:` and
 *     `skills:` are NOT frontmatter keys — an earlier version of this panel
 *     showed both and neither would have parsed. Do not add them.
 *   - Opening a change request is real: `project.cr.open` is a `kortix_cli`
 *     grant in the shipped starter manifest, and layer 06 is where it lands.
 *   - OpenCode is the only harness that may be named, and it is named plainly.
 *   - A denied step is not a failure and must never be coloured like one in the
 *     summary — the run did exactly what it was told to do.
 */

/** What a model hands back when it has nowhere to run. Revealed word by word,
 *  because the thing being dramatised is that text is the entire output. */
const ANSWER =
  'Add exponential backoff, cap it at five attempts, and skip the retry entirely for 4xx responses — those will never succeed. Worth logging the attempt count too.';
const ANSWER_WORDS = ANSWER.split(' ');

type Outcome = 'done' | 'denied';

const STEPS: { id: string; label: string; detail?: string; outcome: Outcome }[] = [
  { id: 'read', label: 'Read the webhook handler', detail: 'webhook-retry.ts', outcome: 'done' },
  { id: 'patch', label: 'Patched the retry to back off', detail: '+18 −6', outcome: 'done' },
  { id: 'test', label: 'Ran the billing suite', detail: '3 passed', outcome: 'done' },
  {
    id: 'push',
    label: 'git push origin main',
    detail: 'blocked by the agent file',
    outcome: 'denied',
  },
  { id: 'cr', label: 'Opened a change request', detail: 'for a human to read', outcome: 'done' },
];

/* ── timing ───────────────────────────────────────────────────────────────
 * Both halves start together and land together. The word cadence is set so the
 * answer finishes at ~1.7s and the run at ~3.1s — close enough that neither
 * pane looks like it is waiting for the other, far enough that the run reads as
 * the thing that took real work.
 * ──────────────────────────────────────────────────────────────────────── */
const WORD_MS = 55;
const WORD_START = 260;
const STEP_MS = 560;
const STEP_START = 700;

/** The swap, at the values the design system specifies for a contextual icon
 *  change: scale 0.25 → 1, opacity 0 → 1, blur 4px → 0, spring, `bounce: 0`.
 *  The blur is what bridges the pending glyph and the verdict into one
 *  transformation instead of two objects trading places. */
const SWAP = { type: 'spring', duration: 0.3, bounce: 0 } as const;

/** Reveal once. `drawn` LATCHES — a comparison that keeps re-running reads as a
 *  loading state, not as a result. */
function usePanelReveal() {
  const ref = useRef<HTMLDivElement>(null);
  const [drawn, setDrawn] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        io.disconnect();
        setDrawn(true);
      },
      { threshold: 0.3 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return { ref, drawn };
}

/** The row's leading glyph: an empty ring until the step resolves, then the
 *  verdict. Fixed-size box with both states stacked absolutely, so the swap
 *  never changes the row's height. */
function StepGlyph({ outcome, resolved }: { outcome: Outcome; resolved: boolean }): ReactNode {
  const reduced = useReducedMotion();
  const denied = outcome === 'denied';

  return (
    <span className="relative flex size-4 shrink-0 items-center justify-center">
      <span
        className={cn(
          'border-muted-foreground/30 absolute size-3.5 rounded-full border transition-opacity duration-200',
          resolved && 'opacity-0',
        )}
      />
      <AnimatePresence initial={false}>
        {resolved && (
          <m.span
            initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.25, filter: 'blur(4px)' }}
            animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
            transition={SWAP}
            className="absolute inset-0 flex items-center justify-center"
          >
            {/* Success is monochrome, exactly as it is in a live burst: a green
                check on every row would out-weigh the one row that says
                something. The denial is the only thing here that earns colour. */}
            {denied ? (
              <ProhibitIcon weight="bold" className="text-kortix-red size-4" />
            ) : (
              <CheckIcon weight="bold" className="text-muted-foreground size-3.5" />
            )}
          </m.span>
        )}
      </AnimatePresence>
    </span>
  );
}

export function StepHarness(): ReactNode {
  const reduced = useReducedMotion();
  const { ref, drawn } = usePanelReveal();
  const [typed, setTyped] = useState(0);
  const [ran, setRan] = useState(0);

  useEffect(() => {
    if (!drawn || reduced) return;
    const ids: ReturnType<typeof setTimeout>[] = [];
    ANSWER_WORDS.forEach((_, i) => {
      ids.push(setTimeout(() => setTyped(i + 1), WORD_START + i * WORD_MS));
    });
    STEPS.forEach((_, i) => {
      ids.push(setTimeout(() => setRan(i + 1), STEP_START + i * STEP_MS));
    });
    return () => ids.forEach(clearTimeout);
  }, [drawn, reduced]);

  /**
   * Reduced motion is DERIVED, never set. An effect that calls `setState` in
   * its own body triggers a cascading render — and there is nothing to store
   * anyway: with motion off, both halves are simply already finished, which is
   * a function of `reduced`, not a fact worth keeping in state.
   */
  const words = reduced ? ANSWER_WORDS.length : typed;
  const steps = reduced ? STEPS.length : ran;
  const denied = steps >= 4;

  const band = (order: number) => ({
    initial: reduced ? { opacity: 0 } : { opacity: 0, y: 8 },
    animate: drawn ? { opacity: 1, y: 0 } : reduced ? { opacity: 0 } : { opacity: 0, y: 8 },
    transition: {
      duration: 0.4,
      ease: [0.23, 1, 0.32, 1] as [number, number, number, number],
      delay: reduced ? 0 : order * 0.08,
    },
  });

  const eyebrow = (title: string, tail: ReactNode) => (
    <div className="flex items-baseline gap-2">
      <span className="text-foreground text-[13px] leading-tight font-medium">{title}</span>
      <span className="text-muted-foreground/60 truncate text-[11px] leading-tight">{tail}</span>
    </div>
  );

  return (
    <div ref={ref} className="flex h-full min-h-0 w-full flex-col overflow-hidden">
      {/* ── The diptych (lg+) ─────────────────────────────────────────── */}
      <div className="hidden h-full grid-cols-[minmax(0,0.85fr)_minmax(0,1fr)] lg:grid">
        {/* Left: what a model gives you. */}
        <m.div {...band(0)} className="flex min-w-0 flex-col gap-3 px-7 py-7">
          {eyebrow('A model on its own', 'answers')}

          <p className="text-foreground/80 text-[13.5px] leading-[1.65] text-pretty">
            {/* Word by word rather than character by character. A per-character
                reveal is a typewriter, and a typewriter is a person typing —
                this is a model generating, and models arrive in tokens. */}
            {ANSWER_WORDS.slice(0, words).join(' ')}
            {/* The caret only exists while there is more coming, so its absence
                is what says the answer is finished. */}
            {words > 0 && words < ANSWER_WORDS.length && (
              <span
                aria-hidden
                className="bg-foreground/50 ml-0.5 inline-block h-[0.95em] w-[0.45em] translate-y-[0.1em] animate-pulse"
              />
            )}
          </p>

          {/* Pinned to the floor, so the empty space above it is the point
              rather than an accident of a short paragraph. */}
          <p className="text-muted-foreground/70 mt-auto text-[12.5px] italic">
            …and then you go and do it.
          </p>
        </m.div>

        {/* Right: what the harness gives you. */}
        <m.div
          {...band(1)}
          className="border-border bg-background/40 flex min-w-0 flex-col gap-3 border-l px-7 py-7"
        >
          {eyebrow(
            'With the harness',
            <span className="inline-flex items-center gap-1.5 align-middle">
              <OpenCode className="size-3" />
              powered by OpenCode
            </span>,
          )}

          <ul className="flex flex-col gap-2.5">
            {STEPS.map((step, index) => {
              const resolved = steps > index;
              const isDenied = resolved && step.outcome === 'denied';
              return (
                <li key={step.id} className="flex items-center gap-2.5">
                  <StepGlyph outcome={step.outcome} resolved={resolved} />
                  <span
                    className={cn(
                      'min-w-0 flex-1 truncate text-[13px] leading-tight transition-colors duration-300',
                      resolved ? 'text-foreground' : 'text-muted-foreground/45',
                      step.id === 'push' && 'font-mono text-[12px]',
                    )}
                  >
                    {step.label}
                  </span>
                  <span
                    className={cn(
                      'shrink-0 text-[11px] leading-tight transition-opacity duration-300',
                      isDenied ? 'text-kortix-red' : 'text-muted-foreground/60',
                      resolved ? 'opacity-100' : 'opacity-0',
                    )}
                  >
                    {step.detail}
                  </span>
                </li>
              );
            })}
          </ul>

          {/* The receipt. It appears at the moment the push is refused, because
              a rule quoted before anything hits it is a caption, and a rule
              quoted at the moment it fires is evidence. */}
          <m.div
            initial={false}
            animate={{ opacity: denied ? 1 : 0 }}
            transition={{ duration: 0.3, ease: [0.23, 1, 0.32, 1] }}
            className="border-border mt-auto flex items-center gap-2 border-t pt-3"
          >
            <span className="text-muted-foreground/50 shrink-0 font-mono text-[10.5px]">
              agents/kortix.md
            </span>
            <span className="text-muted-foreground/30">·</span>
            <span className="text-foreground/80 truncate font-mono text-[10.5px]">
              permission.bash → <span className="text-kortix-red">git push: deny</span>
            </span>
          </m.div>
        </m.div>
      </div>

      {/* ── Below lg: the 256–304px frame cannot hold two columns — the
          harness half only, which is the half that carries the claim. ──── */}
      <div className="flex h-full flex-col justify-center gap-2.5 overflow-y-auto p-4 lg:hidden">
        {eyebrow(
          'With the harness',
          <span className="inline-flex items-center gap-1.5 align-middle">
            <OpenCode className="size-3" />
            powered by OpenCode
          </span>,
        )}
        <ul className="flex flex-col gap-2">
          {STEPS.map((step) => (
            <li key={step.id} className="flex items-center gap-2.5">
              <StepGlyph outcome={step.outcome} resolved />
              <span
                className={cn(
                  'text-foreground min-w-0 flex-1 truncate text-[12.5px] leading-tight',
                  step.id === 'push' && 'font-mono text-[11.5px]',
                )}
              >
                {step.label}
              </span>
              <span
                className={cn(
                  'shrink-0 text-[10.5px] leading-tight',
                  step.outcome === 'denied' ? 'text-kortix-red' : 'text-muted-foreground/60',
                )}
              >
                {step.detail}
              </span>
            </li>
          ))}
        </ul>
        <p className="text-muted-foreground/70 border-border border-t pt-2.5 font-mono text-[10.5px]">
          agents/kortix.md · permission.bash →{' '}
          <span className="text-kortix-red">git push: deny</span>
        </p>
      </div>
    </div>
  );
}

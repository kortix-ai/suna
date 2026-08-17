'use client';

import { cn } from '@/lib/utils';
import {
  BrainIcon,
  GitBranchIcon,
  RobotIcon,
  ShieldIcon,
  SparkleIcon,
} from '@phosphor-icons/react';
import { m, useReducedMotion, type Transition } from 'motion/react';
import { useState, type ComponentType, type ReactNode } from 'react';
import { useStepShowcaseStart } from '../use-step-showcase';

/**
 * Layer 01 — the repo IS the company, drawn as a map rather than as config.
 *
 * WHY THIS IS NOT TWO CODE PANELS ANY MORE
 *
 * The panel used to be a YAML block beside a list of directory paths. Every
 * word on it was accurate and almost none of it was legible: a reader who does
 * not write YAML met two monospace columns and learned that Kortix has config
 * files, which is not the claim. The claim is that ONE repo holds the whole
 * company — who works for you, how they do a job, what they have learned, and
 * what each of them may touch — and that a claim about containment is a shape,
 * not a listing. So the panel is now that shape: one root node, four things
 * hanging off it, connected by a line you can follow.
 *
 * The config did not go away, it stopped leading. It sits at the bottom as a
 * three-line excerpt with its plain-English reading beside it, which is the one
 * place the file earns its space — showing that a rule is a line of text is
 * exactly what makes "files you own" concrete rather than a slogan.
 *
 * ACCURACY GATE — the manifest excerpt below is an EXCERPT, not a complete
 * document (the old panel showed a full `kortix_version: 2` manifest and had to
 * validate clean; this one deliberately does not pretend to). The lines are
 * copied verbatim from that validated manifest, and these rules still bind:
 *   - Agent BEHAVIOUR (model, mode, prompt, permission) is a hard error in
 *     `kortix.yaml` — it lives in `.kortix/opencode/agents/<name>.md`. The
 *     manifest grants; it does not configure the agent. The "Rules" node says
 *     "what each agent may touch" for exactly this reason.
 *   - An omitted grant resolves to `none`. That is what the closing line claims,
 *     and it is why the excerpt shows no `secrets:` key.
 *   - `channels:` is rejected outright in version 2 — channel routing is live
 *     project state, not manifest config. Never add one, here or to the map.
 *   - `secrets:` grants secret NAMES, and a granted secret IS a real env value
 *     inside the session. Never write that it is hidden from the model.
 * Paths are the shipped starter template
 * (`packages/starter/templates/base`), checked file by file: `kortix.yaml` at
 * the repo ROOT, everything else under `.kortix/`. `acme-co`, `invoice-clerk`
 * and `reconcile-invoices` are placeholders, not customers.
 */

/**
 * The four things the repo holds, in the order the layer's own copy names them:
 * agents, skills, memory, then the config that scopes all three.
 *
 * `note` is the whole point of the redesign — it is the node's meaning in words
 * a reader who has never opened a terminal already owns. `path` is the proof
 * underneath it, deliberately the smaller and quieter of the two: the file is
 * evidence for the sentence, not the other way round.
 */
const NODES: {
  id: string;
  icon: ComponentType<{ className?: string }>;
  label: string;
  note: string;
  path: string;
}[] = [
  {
    id: 'agents',
    icon: RobotIcon,
    label: 'Agents',
    note: 'who does the work',
    path: '.kortix/opencode/agents/',
  },
  {
    id: 'skills',
    icon: SparkleIcon,
    label: 'Skills',
    note: 'how your company does a job',
    path: '.kortix/opencode/skills/',
  },
  {
    id: 'memory',
    icon: BrainIcon,
    label: 'Memory',
    note: 'what it has learned so far',
    path: '.kortix/memory/',
  },
  {
    id: 'rules',
    icon: ShieldIcon,
    label: 'Rules',
    note: 'what each agent may touch',
    path: 'kortix.yaml',
  },
];

/**
 * One rule, and its reading. Left column is the file; right column is what a
 * person would say out loud looking at it.
 *
 * Paired rather than stacked so the two columns share a baseline grid — the
 * gloss lands on the same line as the line it glosses, which is what makes it
 * read as a translation instead of as a caption.
 */
const GRANT: { code: string; gloss: string }[] = [
  { code: 'invoice-clerk:', gloss: 'this agent…' },
  { code: '  connectors: [gmail-read]', gloss: '…may read Gmail' },
  { code: '  skills: [reconcile-invoices]', gloss: '…and run one skill' },
];

/**
 * The map builds in reading order: the repo, then the line, then what hangs off
 * it. That is the one thing a still image of this panel cannot say — that the
 * four nodes are INSIDE the first one — so the motion is carrying information,
 * not decorating a diagram.
 *
 * It fires once, from `useStepShowcaseStart` — the same IntersectionObserver
 * the CLI-driven panels in this folder start their movies from. Deliberately
 * NOT motion's `whileInView`: nothing else in this app uses the viewport
 * feature, and its failure mode is a panel frozen at `opacity: 0` rather than
 * an animation that simply does not play. The observer disconnects on the first
 * hit, so the map never rebuilds when the reader scrolls back up.
 */
const ENTER: Transition = { duration: 0.42, ease: [0.23, 1, 0.32, 1] };

/** Neutral tile, never tinted. Four accent colours across four sibling nodes
 *  would be decoration — the design system spends colour on state, and none of
 *  these four nodes has a state. */
function Tile({
  icon: Icon,
  root,
}: {
  icon: ComponentType<{ className?: string }>;
  root?: boolean;
}) {
  return (
    <span
      className={cn(
        'flex items-center justify-center rounded-sm',
        root
          ? 'bg-foreground text-background size-8'
          : 'border-border bg-muted/50 text-muted-foreground size-7 border sm:size-8',
      )}
    >
      <Icon className="size-4" />
    </span>
  );
}

export function StepSourceOfTruth(): ReactNode {
  const reduced = useReducedMotion();
  const [drawn, setDrawn] = useState(false);
  const rootRef = useStepShowcaseStart(() => setDrawn(true));

  /** Reduced motion keeps the fade — it is what says the map finished drawing —
   *  and drops the travel. Never `animation: none`. */
  const from = (y: number) => (reduced ? { opacity: 0 } : { opacity: 0, y });
  /** Every node animates from `from()` to this, gated on the same flag, so a
   *  panel that never enters the viewport is simply invisible rather than
   *  half-drawn. */
  const to = { opacity: 1, y: 0 };
  const step = (delay: number) => ({ ...ENTER, delay: reduced ? 0 : delay });

  return (
    <div
      ref={rootRef}
      // `--spacing` is 0.23rem in this theme, so every step on the scale is ~62%
      // of what it reads as: `p-5` here is 18px, not 20px, and `gap-4` is 15px.
      className="flex h-full min-h-0 w-full flex-col justify-center gap-4 overflow-hidden p-4 sm:gap-5 sm:p-5"
    >
      {/* The map is ONE block with no internal gap, because the connectors are
          drawn as bordered spans inside it — a flex `gap` between the root and
          the grid would cut the stem in half and leave the line floating. All
          vertical spacing inside the map is carried by the connectors
          themselves, and by `space-y-2` at the one width where they are hidden. */}
      <div className="flex flex-col space-y-2 sm:space-y-0">
        <m.div
          initial={from(8)}
          animate={drawn ? to : from(8)}
          transition={step(0)}
          className="flex justify-center"
        >
          <div className="border-border bg-background flex items-center gap-3 rounded-md border px-4 py-3">
            <Tile icon={GitBranchIcon} root />
            <div className="min-w-0">
              <div className="text-foreground font-mono text-sm font-medium">acme-co</div>
              <div className="text-muted-foreground hidden text-xs sm:block">
                one repo — your whole company, as files
              </div>
            </div>
          </div>
        </m.div>

        {/* Stem: root → bus. Hidden at the width where the nodes stack, because
            a single vertical line into a vertical list says nothing the layout
            has not already said. */}
        <m.span
          aria-hidden
          initial={reduced ? { opacity: 0 } : { opacity: 0, scaleY: 0 }}
          animate={drawn ? { opacity: 1, scaleY: 1 } : { opacity: 0, scaleY: reduced ? 1 : 0 }}
          transition={step(0.14)}
          style={{ transformOrigin: 'top' }}
          className="bg-border mx-auto hidden h-6 w-px sm:block"
        />

        {/* The gutter between the four nodes is CELL PADDING at `sm`, not a grid
            `gap`, and `-mx-1.5` on the grid cancels the two outer halves so the
            row still lines up with everything above and below it.

            A `gap` would have been the obvious way to space them and it breaks
            the bus: an absolutely-positioned rail is laid out against its cell's
            padding box, so with a gap the four half-rails end at four cell edges
            with 11px of nothing between them — a connector drawn as four
            disconnected stubs. Padding puts that same 11px INSIDE the cells, the
            cells stay flush, and the rails meet. Below `sm` the nodes are a 2×2
            block with no bus to protect, so an ordinary `gap-2` is fine there. */}
        <div className="grid grid-cols-2 gap-2 sm:-mx-1.5 sm:grid-cols-4 sm:gap-0">
          {NODES.map((node, index) => {
            const first = index === 0;
            const last = index === NODES.length - 1;
            return (
              <m.div
                key={node.id}
                initial={from(10)}
                animate={drawn ? to : from(10)}
                // 60ms apart: enough to read as a sequence, short enough that
                // the whole map has settled inside ~0.7s.
                transition={step(0.22 + index * 0.06)}
                className="relative flex sm:px-1.5 sm:pt-6"
              >
                {/* The bus, drawn as four half-rails rather than one absolute
                    element. A single spanning line would need to know the grid's
                    pixel width; a half-rail per cell only needs to know whether
                    it is an end, so it stays correct at every panel width.
                    Hidden below `sm`, where the nodes are a 2×2 block and there
                    is no single row for a bus to span. */}
                <span
                  aria-hidden
                  className={cn(
                    'bg-border absolute top-0 hidden h-px sm:block',
                    first && 'right-0 left-1/2',
                    last && 'right-1/2 left-0',
                    !first && !last && 'inset-x-0',
                  )}
                />
                {/* The drop. `-translate-x-1/2` because a 1px line placed at
                    `left-1/2` sits half a pixel to the RIGHT of the centre it is
                    supposed to mark, and on a diagram made of hairlines that is
                    the difference between drawn and nearly drawn. */}
                <span
                  aria-hidden
                  className="bg-border absolute top-0 left-1/2 hidden h-6 w-px -translate-x-1/2 sm:block"
                />

                <article className="border-border bg-background flex w-full flex-col gap-2 rounded-md border p-3 sm:gap-2.5 sm:p-4">
                  {/* Icon beside the label when the card is half a column wide,
                      above it when it is a quarter — the same two elements,
                      turned through 90° at the width where the column stops
                      being able to hold them side by side. */}
                  <div className="flex items-center gap-2 sm:flex-col sm:items-start sm:gap-2.5">
                    <Tile icon={node.icon} />
                    <span className="text-foreground text-sm font-medium">{node.label}</span>
                  </div>
                  <p className="text-muted-foreground text-xs leading-snug text-pretty">
                    {node.note}
                  </p>
                  <code className="text-muted-foreground/60 hidden truncate font-mono text-[11px] sm:block">
                    {node.path}
                  </code>
                </article>
              </m.div>
            );
          })}
        </div>
      </div>

      {/* The file, once, at the bottom — where it is evidence for the map
          rather than the thing the reader has to decode first.

          `lg` and up only. Below that the panel's frame is 256–304px tall
          (`MobileCard` in how-it-works.tsx) and the map alone fills it; a strip
          that clips halfway through its own second line is worse than a strip
          that is not there. */}
      <m.div
        initial={from(10)}
        animate={drawn ? to : from(10)}
        transition={step(0.46)}
        className="border-border bg-background hidden rounded-md border lg:block"
      >
        <div className="border-border/70 flex items-center gap-2 border-b px-4 py-2">
          <ShieldIcon className="text-muted-foreground size-3.5" />
          <span className="text-muted-foreground font-mono text-[11px]">kortix.yaml</span>
          <span className="text-muted-foreground/60 ml-auto text-xs">
            one rule, and what it means
          </span>
        </div>

        {/* Both columns run at the same size and the same line-height so the
            gloss sits on the baseline of the line it translates. A 12px gloss
            beside an 11.5px code line drifts by ~3px over three rows, which is
            just enough to read as two unrelated lists. */}
        {/* No `sm:` prefixes in here. The strip itself is `lg` and up, so every
            width that can see it is already past `sm` — a responsive variant
            that can never be false is a variant that hides what the rule does. */}
        <div className="divide-border/70 grid grid-cols-2 divide-x">
          <pre
            // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users must be able to scroll this overflowing code region, as required by Axe.
            tabIndex={0}
            aria-label="A grant in the Kortix project manifest"
            className="overflow-x-auto px-4 py-3 font-mono text-[11.5px] leading-[1.75]"
          >
            <code>
              {GRANT.map((line) => (
                <div key={line.code} className="text-foreground/85">
                  {line.code}
                </div>
              ))}
            </code>
          </pre>

          <ul className="text-muted-foreground px-4 py-3 text-[11.5px] leading-[1.75]">
            {GRANT.map((line) => (
              <li key={line.code}>{line.gloss}</li>
            ))}
          </ul>
        </div>

        <p className="text-muted-foreground/70 border-border/70 border-t px-4 py-2 text-xs">
          Nothing else. A grant you do not write is a grant it does not get.
        </p>
      </m.div>
    </div>
  );
}

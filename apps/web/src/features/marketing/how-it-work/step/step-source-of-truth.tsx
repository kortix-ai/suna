'use client';

import { useLocalizedUiCatalog } from '@kortix/ui/i18n';
import { AgentMark } from '@kortix/ui/internal/components/agent-mark';
import { BookOpenIcon, CpuIcon, LightningIcon, PlugIcon, ShieldIcon, SparkleIcon } from '@phosphor-icons/react';
import { AnimatePresence, m, useInView, useReducedMotion, type Transition } from 'motion/react';
import { useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';

/**
 * Layer 01 — the repo is the company, drawn as its activity feed (Paper
 * "Kortix 2", source of truth v2, Q26).
 *
 * Four changes stacked newest first, each one fainter and narrower than the
 * one above it, over the line "Every change lands in acme-co". While the
 * panel is on screen a new change arrives at the top every few seconds and
 * the oldest falls off the bottom, so the repo reads as something that keeps
 * moving, not a settings page.
 *
 * ACCURACY GATE — every change is something that verifiably lives in the repo:
 *   - Skills, agents and memory are folders at the repo root.
 *   - Rules, triggers, connectors and the machine are declared in `kortix.yaml`.
 * `acme-co` is a placeholder, not a customer.
 *
 * MOTION. Only `transform` and `opacity` move. Rows hand their place over
 * with a layout animation, the new row drops in from above, the old one
 * fades out. Reduced motion shows the first four changes and never cycles.
 */

type Kind = 'skills' | 'rules' | 'triggers' | 'agents' | 'memory' | 'connectors' | 'machine';

const ICONS: Record<Exclude<Kind, 'agents'>, ComponentType<{ className?: string }>> = {
  skills: SparkleIcon,
  rules: ShieldIcon,
  triggers: LightningIcon,
  memory: BookOpenIcon,
  connectors: PlugIcon,
  machine: CpuIcon,
};

/** The feed, newest first. Rows past the fourth arrive one by one. */
const CHANGES: { id: string; kind: Kind; title: string; label: string }[] = [
  { id: 'skill', kind: 'skills', title: 'New skill: weekly report', label: 'Skills' },
  { id: 'rule', kind: 'rules', title: 'Finance can read billing', label: 'Rules' },
  { id: 'trigger', kind: 'triggers', title: 'Runs every Monday at 9:00', label: 'Triggers' },
  { id: 'agent', kind: 'agents', title: 'Support agent added', label: 'Agents' },
  { id: 'memory', kind: 'memory', title: 'Three notes from a refund thread', label: 'Memory' },
  { id: 'connector', kind: 'connectors', title: 'Linear connected', label: 'Connectors' },
  { id: 'machine', kind: 'machine', title: 'Machine image updated', label: 'Machine' },
];

const COPY = { caption: 'Every change lands in', repo: 'acme-co' };

const VISIBLE = 4;
/** Relative time per slot, newest first. */
const AGES = ['now', '2m', '1h', '3h'];
/** Each slot down the stack: fainter, and a little narrower. */
const OPACITY = [1, 0.8, 0.6, 0.4];
const WIDTH = ['max-w-98', 'max-w-92', 'max-w-87', 'max-w-81'];
/** Long enough to read one row, short enough to feel live. */
const TICK_MS = 2800;

const EASE_OUT: Transition['ease'] = [0.22, 1, 0.36, 1];
const MOVE: Transition = { duration: 0.4, ease: EASE_OUT };

export function StepSourceOfTruth(): ReactNode {
  const changes = useLocalizedUiCatalog(CHANGES);
  const copy = useLocalizedUiCatalog(COPY);
  const reduced = useReducedMotion();
  const rootRef = useRef<HTMLDivElement>(null);
  const entered = useInView(rootRef, { once: true, amount: 0.35 });
  const onScreen = useInView(rootRef);
  // `head` is the index of the newest change; the feed shows the four from it,
  // walking backwards through the list so the next arrival is always new.
  const [head, setHead] = useState(0);
  // The first four stagger in once; later arrivals do not.
  const [ticked, setTicked] = useState(false);

  useEffect(() => {
    if (reduced || !onScreen || !entered) return;
    const id = window.setInterval(
      () => {
        setTicked(true);
        setHead((h) => (h - 1 + CHANGES.length) % CHANGES.length);
      },
      TICK_MS,
    );
    return () => window.clearInterval(id);
  }, [reduced, onScreen, entered]);

  const rows = Array.from({ length: VISIBLE }, (_, slot) => changes[(head + slot) % changes.length]);

  return (
    <div
      ref={rootRef}
      className="flex h-full min-h-0 w-full flex-col items-center justify-center gap-2"
    >
      <ul className="flex w-full flex-col items-center gap-2">
        <AnimatePresence initial={false} mode="popLayout">
          {rows.map((change, slot) => {
            const Icon = change.kind === 'agents' ? null : ICONS[change.kind];
            return (
              <m.li
                key={change.id}
                layout={!reduced}
                initial={{ opacity: 0, y: reduced ? 0 : -12 }}
                animate={entered ? { opacity: OPACITY[slot], y: 0 } : { opacity: 0 }}
                exit={{ opacity: 0, transition: { duration: 0.2, ease: EASE_OUT } }}
                transition={{ ...MOVE, delay: ticked || reduced ? 0 : slot * 0.06 }}
                className={`bg-background flex w-full items-center gap-3 rounded-xl border px-4 py-3 ${WIDTH[slot]} ${
                  slot === 0 ? 'border-border shadow-sm' : 'border-border/60'
                }`}
              >
                <span className="bg-card text-foreground flex size-8 shrink-0 items-center justify-center rounded-lg">
                  {Icon ? <Icon className="size-4" /> : <AgentMark slug="support" tile={30} />}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-foreground truncate text-sm font-medium">{change.title}</span>
                  <span className="text-muted-foreground text-xs">{change.label}</span>
                </span>
                <span className="text-muted-foreground shrink-0 text-xs tabular-nums">{AGES[slot]}</span>
              </m.li>
            );
          })}
        </AnimatePresence>
      </ul>

      <m.p
        initial={{ opacity: 0 }}
        animate={entered ? { opacity: 1 } : undefined}
        transition={{ ...MOVE, delay: reduced ? 0 : 0.3 }}
        className="text-muted-foreground pt-3 text-sm"
      >
        {copy.caption} <span className="text-foreground font-mono">{copy.repo}</span>
      </m.p>
    </div>
  );
}

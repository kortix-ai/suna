'use client';

import { useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

/*
 * The step strip of the solution-page heroes: numbered tabs over one panel.
 * It advances every `intervalMs` until a reader picks a step (never with
 * reduced motion); the arrow keys move along the tabs and wrap.
 */

export function useWalkthrough(count: number, intervalMs: number) {
  const reduced = Boolean(useReducedMotion());
  const [selected, setSelected] = useState(0);
  const [held, setHeld] = useState(false);

  useEffect(() => {
    if (reduced || held) return;
    const timer = setInterval(() => setSelected((n) => (n + 1) % count), intervalMs);
    return () => clearInterval(timer);
  }, [reduced, held]);

  const pick = (i: number) => {
    setHeld(true);
    setSelected(i);
  };

  return { selected, pick };
}

export function WalkTabs({
  steps,
  idPrefix,
  label,
  selected,
  pick,
}: {
  steps: readonly { id: string; label: string }[];
  idPrefix: string;
  label: string;
  selected: number;
  pick: (i: number) => void;
}) {
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const next = (selected + step + steps.length) % steps.length;
    pick(next);
    tabRefs.current[next]?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
      className="flex flex-wrap justify-center gap-2"
    >
      {steps.map((s, i) => (
        <button
          key={s.id}
          ref={(el) => {
            tabRefs.current[i] = el;
          }}
          type="button"
          role="tab"
          id={`${idPrefix}-${s.id}`}
          aria-controls={`${idPrefix}-panel`}
          aria-selected={i === selected}
          tabIndex={i === selected ? 0 : -1}
          onClick={() => pick(i)}
          className="text-muted-foreground hover:text-foreground aria-selected:bg-background aria-selected:text-foreground outline-ring duration-normal aria-selected:border-border flex items-center gap-2 rounded-md border border-transparent px-3 py-1.5 text-sm transition-colors ease-out focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          <span className="font-mono text-xs tabular-nums">{i + 1}</span>
          {s.label}
        </button>
      ))}
    </div>
  );
}

export function WalkPanel({
  idPrefix,
  stepId,
  className,
  children,
}: {
  idPrefix: string;
  stepId: string;
  className: string;
  children: ReactNode;
}) {
  return (
    <div
      role="tabpanel"
      id={`${idPrefix}-panel`}
      aria-labelledby={`${idPrefix}-${stepId}`}
      className={className}
    >
      {children}
    </div>
  );
}

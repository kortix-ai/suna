'use client';

/**
 * The plan, pinned beneath the user message that owns it (see plan-anchor.ts).
 *
 * Replaces TodoChip in the composer. Data is live: the `todo.updated` SSE event
 * writes into the same query cache this hook reads.
 */

import { useRuntimeSessionTodo } from '@kortix/sdk/react';
import { CaretRightIcon } from '@phosphor-icons/react';
import { useState } from 'react';

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { parseTodos, TodoStatusIcon } from '@/features/session/tool/shared/todo-helpers';
import { cn } from '@/lib/utils';

/**
 * One rail for every row in this card.
 *
 * `TodoStatusIcon` is `size-4` in all four of its states, so 16px is the rail
 * width and `gap-2.5` (10px) is its gutter — every text column in the card,
 * trigger included, therefore starts at the same 26px. `leading-5` gives each
 * row an identical 20px line box, so the rows are parallel down the card and
 * not merely left-aligned.
 */
const RAIL_ROW = 'flex gap-2.5';
const RAIL_SLOT = 'size-4 shrink-0';
const ROW_TEXT = 'text-xs leading-5';
/** (20px line box − 16px glyph) / 2 — centres the glyph on the FIRST line of
 *  a todo that wraps, which `items-start` alone cannot do. */
const GLYPH_ON_FIRST_LINE = 'mt-0.5';

/**
 * The ring and the caret share one 16px slot and cross-fade in place, so the
 * row never reflows when the pointer arrives. Scale + blur (rather than a plain
 * opacity swap) blends the two shapes into one another instead of showing them
 * overlapping mid-transition.
 *
 * `scale`/`rotate` are listed individually because Tailwind v4 compiles
 * `scale-*` and `rotate-*` to the standalone `scale` / `rotate` properties,
 * not to `transform`. Never `transition-all`.
 */
const ICON_SLOT = cn(
  'absolute inset-0 size-4 text-muted-foreground',
  'transition-[opacity,scale,rotate,filter] duration-150 ease-[cubic-bezier(0.2,0,0,1)]',
  'motion-reduce:transition-none',
);

/**
 * How far the wedge sweeps, and which state the plan is in. Split out so the
 * edge cases — an empty plan, nothing started, every item done — are
 * unit-testable without a browser.
 */
export function planPieState(done: number, total: number, running: boolean) {
  const sweep = total === 0 ? 0 : (done / total) * 360;
  if (total > 0 && done === total) return { sweep, state: 'complete' as const };
  if (running) return { sweep, state: 'running' as const };
  return { sweep, state: 'idle' as const };
}

/**
 * Progress as a solid pie, drawn entirely in CSS: one `conic-gradient` wedge
 * cut from the centre over a flat track — a cake with slices taken out.
 *
 * The wedge carries the state in its colour, since a solid pie has no centre
 * to put it in: amber while an item is running, green once the plan is done.
 * Both are the colours `TodoStatusIcon` already uses in the list below, so the
 * summary and the list speak one language.
 */
function PlanPie({
  done,
  total,
  running,
  className,
}: {
  done: number;
  total: number;
  running: boolean;
  className?: string;
}) {
  const { sweep, state } = planPieState(done, total, running);
  const fill = state === 'running' ? 'text-kortix-orange' : 'text-emerald-600';

  return (
    <span
      className={cn('bg-muted-foreground/20 block rounded-full', className, fill)}
      style={{ backgroundImage: `conic-gradient(currentColor ${sweep}deg, transparent 0)` }}
      aria-hidden="true"
    />
  );
}

export function planSummary(todos: ReadonlyArray<{ status: string; content: string }>) {
  const total = todos.length;
  const done = todos.filter((todo) => todo.status === 'completed').length;
  const current = todos.find((todo) => todo.status === 'in_progress')?.content;
  return {
    done,
    total,
    percent: total === 0 ? 0 : Math.round((done / total) * 100),
    current,
  };
}

export function PlanCard({ sessionId }: { sessionId: string }) {
  const { data } = useRuntimeSessionTodo(sessionId);
  const [open, setOpen] = useState(false);

  const todos = parseTodos(data);
  if (todos.length === 0) return null;

  const { done, total, current } = planSummary(todos);

  return (
    <Collapsible className="group/plan" open={open} onOpenChange={setOpen}>
      <div className="bg-accent rounded-none border-none px-3 py-1.5">
        {/* CollapsibleTrigger renders a <button>, whose content model is
            phrasing content — every child here is a <span>, never a <div>
            or <p>. */}
        <CollapsibleTrigger
          className={cn(RAIL_ROW, 'w-full cursor-pointer items-center text-left')}
        >
          {/* At rest the slot reports progress. It only turns into a caret once
              the pointer arrives (or the plan is open), which is the moment the
              reader needs to know it expands. */}
          <span className={cn('relative flex items-center justify-center', RAIL_SLOT)}>
            <PlanPie
              done={done}
              total={total}
              running={Boolean(current)}
              className={cn(
                ICON_SLOT,
                'group-hover/plan:scale-25 group-hover/plan:opacity-0 group-hover/plan:blur-[4px]',
                'group-data-[state=open]/plan:scale-25 group-data-[state=open]/plan:opacity-0 group-data-[state=open]/plan:blur-[4px]',
              )}
            />
            <CaretRightIcon
              className={cn(
                ICON_SLOT,
                'scale-25 opacity-0 blur-[4px]',
                'group-hover/plan:scale-100 group-hover/plan:opacity-100 group-hover/plan:blur-[0px]',
                'group-data-[state=open]/plan:scale-100 group-data-[state=open]/plan:opacity-100 group-data-[state=open]/plan:blur-[0px]',
                // A caret-right turned 90° points down: the open state, and the
                // reason this is a caret-right rather than a caret-down.
                'group-data-[state=open]/plan:rotate-90',
              )}
            />
          </span>
          {/* items-baseline: "Plan" and the count sit on one baseline, which
              tabular figures make exact. */}
          <span className={cn('flex min-w-0 flex-1 items-baseline gap-2', ROW_TEXT)}>
            <span className="text-foreground">Plan</span>
            <span className="text-muted-foreground tabular-nums">
              {done} of {total}
            </span>
          </span>
        </CollapsibleTrigger>

        {!open && current && (
          <div className={cn(RAIL_ROW, 'text-muted-foreground mt-2 items-center', ROW_TEXT)}>
            <TodoStatusIcon status="in_progress" />
            <span className="min-w-0 flex-1 truncate">{current}</span>
          </div>
        )}

        <CollapsibleContent>
          {/* No stepper rail. Each todo carries its own status glyph, so the
              connecting separator drew a second, weaker reading of the same
              sequence the list already implies. */}
          <ul className="mt-3 flex w-full flex-col gap-2">
            {todos.map((todo, index) => (
              <li key={index} className={cn(RAIL_ROW, 'items-start')}>
                <span className={cn('flex', RAIL_SLOT, GLYPH_ON_FIRST_LINE)}>
                  <TodoStatusIcon status={todo.status} />
                </span>
                <p
                  className={cn(
                    'min-w-0 flex-1 text-pretty',
                    ROW_TEXT,
                    todo.status === 'completed'
                      ? 'text-muted-foreground/60 line-through'
                      : 'text-foreground/85',
                  )}
                >
                  {todo.content}
                </p>
              </li>
            ))}
          </ul>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

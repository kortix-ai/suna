'use client';

/**
 * `PlanPanelCard` — the plan, as the Easy panel's fourth card.
 *
 * The panel already answers three questions about a session, each from one
 * live singleton: what did it make (Outputs), what does it know (Context),
 * what is it running (Preview). "What is it doing" was the missing fourth, and
 * it lived in the transcript instead — pinned under whichever user message
 * `plan-anchor.ts` judged to own it.
 *
 * That placement fought the data. The plan is ONE mutable list on ONE query
 * key for the whole session, so drawing it at a fixed point in a scrolling
 * history meant: an anchor that has to be guessed, an anchor that jumps
 * forward every time the agent re-plans, a fallback for when compaction eats
 * the `todowrite` parts that would have identified it — and, once the user
 * scrolled, a live checklist they could no longer see. Here it is none of
 * those things. It is a card that reads the key.
 *
 * It draws last, under Preview. The column reads finished → known → running →
 * planned, and the plan sits closest to the composer, which is where the eye
 * already is while an agent works.
 *
 * THIS IS THE PLAN'S ONLY HOME ON DESKTOP. Collapsing the column (Cmd/Ctrl+I)
 * or covering it with a detail panel hides the plan; it does not send it back
 * to the transcript. That is deliberate — see `planBelongsToChat`, which also
 * says why not to re-add a visibility branch. The chat keeps the plan on
 * mobile only, where no panel column exists at all. `usePlanInChat`
 * (`plan-surface.ts`) makes that call once and both surfaces read it, so
 * exactly one is ever mounted. See `turn/plan-card.tsx`, which owns the ring
 * and the step rows both surfaces draw.
 */

import { useRuntimeSessionTodo } from '@kortix/sdk/react';
import { useMemo } from 'react';

import {
  keyTodos,
  PlanRing,
  planListTodos,
  planSummary,
  PlanSteps,
} from '@/features/session/turn/plan-card';
import { parseTodos, type TodoItem } from '@/features/session/tool/shared/todo-helpers';
import { cn } from '@/lib/utils';
import { PanelCard } from './panel-card';

/**
 * The card's size, in the slot every sibling puts its count badge.
 *
 * A plan's size is a fraction, so it is stated twice — the dial for the
 * glance, the figures for the answer. That is the same redundancy the ring
 * itself is built on (ticks are exact but need counting, the pie is instant
 * but coarse), carried one level up.
 *
 * `size-4` matches the rail the steps below use, so the header's dial and the
 * list's status glyphs are one drawing at one size. `tabular-nums` keeps
 * "3 of 6" from reflowing into "10 of 12" as the agent advances.
 */
function PlanProgress({ done, total, running }: { done: number; total: number; running: boolean }) {
  return (
    <span className="flex items-center gap-1.5">
      <PlanRing done={done} total={total} running={running} className="size-4 shrink-0" />
      <span className="text-muted-foreground text-xs tabular-nums">
        {done} of {total}
      </span>
    </span>
  );
}

/**
 * The rows the card lists — the plan minus the row its subtitle already heads.
 *
 * `planListTodos` drops the running step because the header is showing it, and
 * printing the same sentence twice was the reason that filter exists. But a
 * ONE-step plan filters to nothing, and a chevron that rewards a click with an
 * empty box is a worse lie than a line repeated. Fall back to the whole list
 * in exactly that case — which is exactly the case where "twice" costs a
 * single row.
 *
 * Pure, so both branches are testable without mounting anything.
 */
export function planPanelRows(
  todos: ReadonlyArray<TodoItem>,
): Array<{ todo: TodoItem; key: string }> {
  // Keyed first, filtered second — see `planListTodos`: keying first is what
  // keeps React's row state attached as the agent advances past a step.
  const keyed = keyTodos(todos);
  const listed = planListTodos(keyed);
  return listed.length > 0 ? listed : keyed;
}

export function PlanPanelCard({ sessionId }: { sessionId: string }) {
  const { data } = useRuntimeSessionTodo(sessionId);

  const todos = useMemo(() => parseTodos(data), [data]);
  const rows = useMemo(() => planPanelRows(todos), [todos]);

  const { done, total, current, label, complete } = planSummary(todos);

  // No plan, no card — the same rule the chat surface has always used.
  //
  // Outputs and Context earn their permanent empty "promise" state because
  // almost every session fills them. Plenty of sessions never call
  // `todowrite`, so an always-mounted Plan row would be a title bar that stays
  // inert for the whole session: a filler widget. The column already has a
  // conditional card (Preview) to follow instead.
  if (total === 0) return null;

  return (
    <PanelCard
      title="Plan"
      // Never the promise state — the card does not exist without a plan.
      isEmpty={false}
      // No `count`. `indicator` stands in its slot with the fraction, which is
      // what "how big is this card" means for a plan.
      indicator={<PlanProgress done={done} total={total} running={Boolean(current)} />}
      // The live step, always visible — the panel's one advantage over the
      // transcript is that it does not scroll away, and this is the line that
      // makes that worth something. Undefined before the plan starts is
      // deliberate: the dial and "0 of 6" already say so, and a filler line
      // would only make the header taller (see `planSummary`).
      subtitle={
        label ? (
          <span
            className={cn(
              // `block`, not a bare span: `truncate` needs a block box to
              // clip against, and the header column already caps the width.
              'block truncate text-xs',
              complete ? 'text-muted-foreground' : 'text-foreground/70',
            )}
          >
            {label}
          </span>
        ) : undefined
      }
      // `px-3.5` matches the header's own inset, so a step's glyph sits on the
      // same left edge as the title above it.
      contentClassName="border-border border-t px-3.5 py-3"
      defaultExpanded={true}
    >
      <PlanSteps rows={rows} />
    </PanelCard>
  );
}

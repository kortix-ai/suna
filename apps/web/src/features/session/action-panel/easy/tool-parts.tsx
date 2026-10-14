'use client';

import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import type { ToolCallBlock } from '@kortix/sdk';
import { isPlanWriteTool } from '@/features/session/turn/plan-anchor';

import { ToolPartRenderer, ToolSurfaceContext } from '../../tool/tool-renderers';

/** Tools that re-send their ENTIRE state on every call rather than a delta. */
function isSnapshotTool(tool: string): boolean {
  return isPlanWriteTool(tool);
}

/**
 * `todo_write` doesn't append a task — it re-sends the whole checklist, every
 * time, with the statuses as they now stand. So a step that grouped three of
 * them was rendering the same list three times over (0/4, then 1/4, then 4/4)
 * and reading as three separate to-do lists. They are three photographs of one
 * list, and only the last one is still true.
 *
 * Keep the final snapshot; drop the ones it superseded. Any non-snapshot call in
 * the step is a real distinct event and survives untouched.
 */
export function collapseSnapshots(calls: ToolCallBlock[]): ToolCallBlock[] {
  let lastSnapshot = -1;
  calls.forEach((call, i) => {
    if (isSnapshotTool(call.name)) lastSnapshot = i;
  });
  if (lastSnapshot < 0) return calls;
  return calls.filter((call, i) => !isSnapshotTool(call.name) || i === lastSnapshot);
}

/** The real tool views for a set of calls — the escape hatch's payload. */
export function ToolParts({
  calls,
  sessionId,
  summary,
}: {
  calls: ToolCallBlock[];
  sessionId: string;
  /**
   * A plain-language sentence to show above the raw tool views (W3) — e.g.
   * "Read 3 files". Opt-in: only the Context card's tool-group rows
   * (`context-card.tsx`) pass one, built by reusing `narrateStep`/
   * `narrateFailedStep` over the group's own `calls`. `StepDetailBody` leaves
   * this unset — a Progress step's narration already sits in the detail's
   * own header, and repeating it here would just say the same line twice.
   */
  summary?: string;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const visible = collapseSnapshots(calls);
  // A step's own icon already went red for this (StepIcon, ContextCard) — but
  // that glance lives on the panel's home, one screen back. Once the user has
  // actually opened the failed step, the detail must say so too, not just show
  // a tool view that looks the same as a success (failed-call aggregation).
  const failed = visible.some((call) => call.status === 'error');

  // A lone `show` call IS the preview: `ToolPartRenderer` sizes it `h-full`
  // (`fillsPanel`), and that height only resolves if this column has one too.
  // Without it the preview's iframe fell back to the browser's 150px default.
  const fillsPanel =
    visible.length === 1 && (visible[0].name === 'show' || visible[0].name === 'show-user');

  return (
    <ToolSurfaceContext.Provider value="panel">
      <div
        className={cn(
          'flex min-w-0 flex-col gap-2',
          fillsPanel && 'h-full',
          // Tool views cap their own scroll height for the inline chat, where
          // they're one item among many. Here the detail IS the tool — a web
          // search that shows 5 of its 20 results behind an inner scrollbar is
          // hiding what the user opened it to see. The detail's own container
          // scrolls instead. Same un-cap the Advanced stepper applies.
          // Height only, not overflow: overflow-visible kills the x-axis
          // scrollbar ToolCodeCard needs for long mono lines, clipping
          // memory/read/edit/write output at the card frame.
          '[&_[data-scrollable]]:max-h-none',
        )}
      >
        {summary && <p className="text-muted-foreground text-sm text-pretty">{summary}</p>}
        {failed && (
          <div className="border-kortix-red/30 bg-kortix-red/5 text-foreground rounded-md border px-3 py-2 text-sm">
            {tI18nComplete.raw('text4e1c9bd64a7d')}
          </div>
        )}
        {/* One rendered call → open it; several → every row starts closed and
            the detail reads as a list of what happened, which is the only way
            a three-call step is skimmable at all. Counted on `visible`, not
            `calls`: `collapseSnapshots` can fold three `todo_write` calls into
            the single row that is actually drawn, and that lone row is a
            single-part detail by every measure the reader has. */}
        {visible.map((call) => (
          <ToolPartRenderer
            key={call.call_id}
            call={call}
            sessionId={sessionId}
            defaultOpen={visible.length === 1}
          />
        ))}
      </div>
    </ToolSurfaceContext.Provider>
  );
}

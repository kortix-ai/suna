'use client';

/**
 * Variant C — "Narrative".
 *
 * Thesis: the default transcript contains ONLY what a non-technical reader
 * would read aloud — what they asked, what the agent said, and what it
 * produced. ALL machinery collapses to one faint work line per turn. This is
 * the most aggressive of the three variants, closest to Claude Cowork.
 *
 * What can never be hidden, even here: deliverables (`show`, images, decks —
 * `isDeliverableTool`), self-rendering content (todos, questions, sub-agent
 * cards — `isSelfRenderingTool`, surfaced through the model's `passthrough`
 * item), and errors. Everything else — every shell command, read, write,
 * search — is one word in "14 steps" until the reader asks to see it.
 */

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import Loading from '@/components/ui/loading';
import { UnifiedMarkdown } from '@/components/markdown/unified-markdown';
import { ToolPartRenderer } from '@/features/session/tool/tool-renderers';
import { cn } from '@/lib/utils';
import { type ReasoningPart, type Turn, isTextPart, isToolPart } from '@/ui';
import { ChevronRight } from 'lucide-react';
import { useState } from 'react';
import {
  type ActivityEntry,
  buildActivityItems,
  formatActivityDuration,
  summarizeEntries,
} from '../activity-model';
import { WorkStepRow } from '../work-step-row';
import { AssistantProse, UserBubble, useTurnParts, useTurns } from './shared';
import type { ChatVariantProps } from './types';


function isErrored(entry: ActivityEntry): boolean {
  return (entry.part.state as { status?: string } | undefined)?.status === 'error';
}

/**
 * One ghost line for a turn's non-deliverable work. Nearly invisible at rest
 * — a reader shouldn't have to look away from the prose to notice it's
 * there — but legible enough while running to reassure, and one click from
 * the full human step list.
 */
function WorkLine({
  entries,
  reasoning,
  sessionId,
}: {
  entries: ActivityEntry[];
  sessionId: string;
  /** The turn's thinking. Folded in here rather than dropped: Narrative hides
   *  machinery at rest, but nothing may become UNREACHABLE — reasoning that
   *  renders nowhere is content loss, not a fold. */
  reasoning: ReasoningPart[];
}) {
  const [open, setOpen] = useState(false);
  const reasoningText = reasoning
    .map((p) => p.text ?? '')
    .join('\n\n')
    .trim();
  if (entries.length === 0 && !reasoningText) return null;

  const summary = summarizeEntries(entries);
  const duration = formatActivityDuration(summary.durationMs);
  const stepWord = summary.totalSteps === 1 ? 'step' : 'steps';

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <div
          className={cn(
            'group/work text-muted-foreground/45 hover:text-muted-foreground hover:bg-muted/40',
            '-mx-1.5 flex w-fit cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-xs',
            'select-none transition-[color,background-color]',
          )}
        >
          {summary.running && <Loading className="size-3 shrink-0" />}
          <span className="tabular-nums">
            {summary.running
              ? `Working… · ${summary.totalSteps} ${stepWord}`
              : `${summary.totalSteps} ${stepWord}${duration ? ` · ${duration}` : ''}`}
          </span>
          <ChevronRight
            className={cn(
              'size-3 shrink-0 opacity-0 transition-[opacity,transform] group-hover/work:opacity-100',
              open && 'rotate-90 opacity-100',
            )}
          />
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-border/40 mt-1.5 mb-1 ml-1 space-y-0.5 border-l pl-3">
          {reasoningText && (
            <div className="text-muted-foreground/60 mb-1.5 space-y-2 text-xs leading-relaxed italic [&_.kortix-markdown]:italic">
              <UnifiedMarkdown content={reasoningText} />
            </div>
          )}
          {/* Actionable, not decorative: in a session this opens the step in
              the side panel; in the demo (no panel) it expands the real tool
              output inline. Same component the product uses. */}
          {entries.map(({ part }) => (
            <WorkStepRow key={part.id} part={part} sessionId={sessionId} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function VariantNarrative({ messages, sessionId, isBusy }: ChatVariantProps) {
  const turns = useTurns(messages);
  return (
    <div className="space-y-10">
      {turns.map((turn) => (
        <TurnBody key={turn.userMessage.info.id} turn={turn} sessionId={sessionId} isBusy={isBusy} />
      ))}
    </div>
  );
}

function TurnBody({ turn, sessionId }: { turn: Turn; sessionId: string; isBusy?: boolean }) {
  const parts = useTurnParts(turn);
  const items = buildActivityItems(parts, { density: 'simple' });

  // Every tool call in the turn, folded or not — this is the raw material
  // the ghost line summarises. Deliverables and self-rendering tools
  // (todos, questions, sub-agents) never enter it; they render in place below.
  const machinery: ActivityEntry[] = items.flatMap((item) =>
    item.type === 'group' ? item.entries : item.type === 'tool' ? [item.entry] : [],
  );
  // Errors are the one kind of machinery that can't fold into a faint line —
  // a reader has to see something went wrong without expanding anything.
  const failed = machinery.filter(isErrored);
  const ok = machinery.filter((entry) => !isErrored(entry));

  // Reasoning is machinery too — it folds into the work line rather than
  // rendering as body text, and rather than vanishing.
  const reasoning: ReasoningPart[] = items.flatMap((item) =>
    item.type === 'reasoning' ? item.parts : [],
  );

  // What a non-technical reader reads: the agent's own words, what it
  // produced, and anything it needs an answer from them for — in the order
  // it actually happened.
  const content = items.filter(
    (item) => item.type === 'text' || item.type === 'deliverable' || item.type === 'passthrough',
  );

  return (
    <div className="space-y-4">
      <UserBubble turn={turn} />
      <div className="space-y-3">
        <WorkLine entries={ok} reasoning={reasoning} sessionId={sessionId} />

        {failed.map((entry) => (
          <ToolPartRenderer key={entry.part.id} part={entry.part} sessionId={sessionId} />
        ))}

        {content.map((item) => {
          if (item.type === 'text') {
            return (
              <AssistantProse
                key={item.key}
                className="max-w-[70ch] text-[15px] leading-7 text-pretty"
                text={isTextPart(item.part) ? (item.part.text ?? '') : ''}
              />
            );
          }
          if (item.type === 'deliverable') {
            return <ToolPartRenderer key={item.key} part={item.entry.part} sessionId={sessionId} />;
          }
          // passthrough — self-rendering tools (todos, questions, sub-agent
          // cards). Anything else the model doesn't own is left to its own
          // caller and never printed as raw content here.
          if (item.type === 'passthrough' && isToolPart(item.part)) {
            return <ToolPartRenderer key={item.key} part={item.part} sessionId={sessionId} />;
          }
          return null;
        })}
      </div>
    </div>
  );
}

'use client';

/**
 * One segment of a turn's assistant content — a burst, a standalone tool part,
 * or a run of prose.
 *
 * Extracted verbatim from the `.map` callback inside `SessionTurnImpl`'s
 * segment region. `segmentTurn` now runs in `computeTurnParts`; this component
 * renders exactly one of its results, so the caller can render the segments as
 * separate rows.
 */

import { UnifiedMarkdown } from '@/components/markdown/unified-markdown';
import { Button } from '@/components/ui/button';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import { ToolPartRenderer } from '@/features/session/tool/tool-renderers';
import { cn } from '@/lib/utils';
import { type ToolPart, getPermissionForTool, shouldShowToolPart } from '@/ui';
import { CaretDownIcon as ChevronDown } from '@phosphor-icons/react';
import { useState } from 'react';
import type { SessionTurnProps } from '../session-chat';
import { ActivityBurst } from './activity-burst';
import type { Segment } from './segment-turn';
import { ThrottledMarkdown } from './throttled-markdown';

// ============================================================================
// Answered question card — collapsible summary of completed Q&A
// ============================================================================

export function AnsweredQuestionCard({ part }: { part: ToolPart }) {
  const [expanded, setExpanded] = useState(false);
  const input = (part.state as any)?.input ?? {};
  const metadata = (part.state as any)?.metadata ?? {};
  const questions: Array<{ question: string; options?: { label: string }[] }> = Array.isArray(
    input.questions,
  )
    ? input.questions
    : [];
  const answers: string[][] = Array.isArray(metadata.answers) ? metadata.answers : [];
  if (questions.length === 0 || answers.length === 0) return null;

  const answeredCount = answers.filter((a) => a.length > 0).length;

  return (
    <Disclosure
      variant="outline"
      className="bg-card overflow-hidden"
      open={expanded}
      onOpenChange={setExpanded}
    >
      <DisclosureTrigger variant="outline">
        <Button
          type="button"
          variant="popover"
          className="bg-card flex h-auto w-full items-center justify-start gap-1.5 rounded-none px-4 py-2.5 text-left"
        >
          <span className="text-foreground text-xs font-medium">Questions</span>
          <span className="text-muted-foreground text-xs tabular-nums">
            {answeredCount} answered
          </span>
          <ChevronDown
            className={cn(
              'text-muted-foreground ml-auto shrink-0 transition-transform',
              expanded && 'rotate-180',
            )}
          />
        </Button>
      </DisclosureTrigger>
      <DisclosureContent variant="outline" contentClassName="border-border border-t">
        <div className="space-y-4 px-4 py-2.5">
          {questions.map((q, i) => {
            const answer = answers[i] || [];
            const answerText = answer.join(', ') || 'No answer';
            return (
              <div key={i} className="space-y-1">
                <div className="[&_*]:!text-muted-foreground [&_strong]:!text-muted-foreground [&_code]:!text-xs [&_li]:!my-0 [&_ol]:!my-0 [&_p]:!my-0 [&_p]:!text-xs [&_p]:!leading-relaxed [&_p]:!text-pretty [&_ul]:!my-0">
                  <UnifiedMarkdown content={q.question} />
                </div>
                <p className="text-foreground text-sm font-medium text-pretty">{answerText}</p>
              </div>
            );
          })}
        </div>
      </DisclosureContent>
    </Disclosure>
  );
}

/**
 * The three per-turn values a segment reads.
 *
 * Deliberately not `TurnModel`: a segment row must render without calling a
 * single hook, so the transcript derives these once per turn with
 * `computeTurnRowInputs` and hands the same object to every segment of that
 * turn. Widening this back to the full model would put `useTurnModel` — a
 * ~30-value derivation over the turn's whole part list — behind every one of
 * the ~30 mounted segment rows.
 */
export interface TurnSegmentContext {
  working: boolean;
  hasSteps: boolean;
  answeredQuestionPartsById: Map<string, ToolPart>;
}

export function TurnSegment({
  context,
  props,
  segment,
  segIndex,
  isTrailing,
}: {
  context: TurnSegmentContext;
  props: SessionTurnProps;
  segment: Segment;
  segIndex: number;
  isTrailing: boolean;
}) {
  const { working, answeredQuestionPartsById, hasSteps } = context;
  const { sessionId, disableToolNavigation, permissions, onPermissionReply } = props;

  if (segment.kind === 'burst') {
    return (
      <ActivityBurst
        key={`burst-${segment.parts[0]?.id ?? segIndex}`}
        parts={segment.parts}
        sessionId={sessionId}
        working={working}
        isTrailing={isTrailing}
        disableNavigation={disableToolNavigation}
      />
    );
  }

  if (segment.kind === 'standalone') {
    if (!shouldShowToolPart(segment.part)) return null;
    // Render answered questions via AnsweredQuestionCard instead of
    // ToolPartRenderer to avoid the "Question(s)" label and badge
    // from QuestionTool; answered cards show "Questions · N answered" instead.
    // Use the part from the map (may contain optimistically-cached answers).
    if (answeredQuestionPartsById.has(segment.part.id)) {
      const part = answeredQuestionPartsById.get(segment.part.id)!;
      return <AnsweredQuestionCard key={segment.part.id} part={part} />;
    }
    return (
      <ToolPartRenderer
        key={segment.part.id}
        part={segment.part}
        sessionId={sessionId}
        disableNavigation={disableToolNavigation}
        permission={getPermissionForTool(permissions, segment.part.callID)}
        onPermissionReply={onPermissionReply}
      />
    );
  }

  // Text segments render as prose between bursts. Text rendering
  // for no-step turns is handled below in the dedicated response
  // section, to avoid duplicate output.
  if (!hasSteps) return null;
  const text = segment.part.text?.trim();
  if (!text) return null;
  return (
    <div key={segment.part.id} className="min-w-0 text-sm">
      <ThrottledMarkdown content={text} isStreaming={working} />
    </div>
  );
}

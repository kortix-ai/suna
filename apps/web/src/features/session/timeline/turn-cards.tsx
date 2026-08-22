'use client';

/**
 * The small cards a turn renders around its parts. Moved verbatim out of
 * `session-chat.tsx` with the turn card; nothing here changed.
 */
import { UnifiedMarkdown } from '@/components/markdown/unified-markdown';
import { Button } from '@/components/ui/button';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import { cn } from '@/lib/utils';
import type { KortixSystemMessage, SessionReport } from '@/lib/utils/kortix-system-tags';
import type { ToolPart } from '@/ui';
import {
  WarningIcon as AlertTriangle,
  CheckCircleIcon as CheckCircle,
  CaretDownIcon as ChevronDown,
  ArrowSquareOutIcon as ExternalLink,
  StackIcon as Layers,
} from '@phosphor-icons/react';
import { useState } from 'react';

// ============================================================================
// System message indicator — subtle inline pill for kortix_system messages
// ============================================================================

export function SystemMessageIndicator({ messages }: { messages: KortixSystemMessage[] }) {
  if (messages.length === 0) return null;

  // Combine all messages into a single line: "Goal · iteration 3/50"
  const parts = messages.map((msg) => (msg.detail ? `${msg.label} · ${msg.detail}` : msg.label));
  const text = parts.join('  ·  ');

  return (
    <div className="-my-1 flex items-center gap-2">
      <div className="bg-border/30 h-px flex-1" />
      <span className="text-muted-foreground/30 text-xs whitespace-nowrap select-none">{text}</span>
      <div className="bg-border/30 h-px flex-1" />
    </div>
  );
}

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
          className="bg-card flex h-auto w-full items-center justify-start gap-1.5 rounded-none px-4 py-2 text-left"
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
        <div className="space-y-2 px-3.5 py-2">
          {questions.map((q, i) => {
            const answer = answers[i] || [];
            const answerText = answer.join(', ') || 'No answer';
            return (
              <div key={q.question} className="space-y-0.5">
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

// ============================================================================
// Session report card
// ============================================================================

/**
 * The worker-run result row shown above a turn — an entity row in the design
 * system's sense, not a tinted banner: the surface stays neutral and the status
 * lives in one tinted icon tile, so a run of these reads as a list rather than
 * a stack of coloured alerts.
 */
export function SessionReportCard({
  report,
  onOpen,
}: {
  report: SessionReport;
  onOpen: () => void;
}) {
  const complete = report.status === 'COMPLETE';
  return (
    // A real <button>: Enter, Space and the focus ring come free, where the
    // previous role="button" div hand-rolled Enter only.
    <button
      type="button"
      onClick={onOpen}
      className="group/report bg-popover hover:bg-accent/40 flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left transition-colors active:scale-[0.99]"
    >
      <span
        className={cn(
          'flex size-8 shrink-0 items-center justify-center rounded-sm',
          complete ? 'bg-kortix-green/15' : 'bg-kortix-red/15',
        )}
      >
        {complete ? (
          <CheckCircle className="text-kortix-green size-4" />
        ) : (
          <AlertTriangle className="text-kortix-red size-4" />
        )}
      </span>

      <span className="min-w-0 flex-1">
        <span className="text-foreground block truncate text-sm font-medium">
          Worker {complete ? 'complete' : 'failed'}
        </span>
        {/* One meta line, truncated by CSS against the real available width —
            the old 60-character slice cut mid-word at every viewport and still
            overflowed narrow ones. */}
        {(report.project || report.prompt) && (
          <span className="text-muted-foreground block truncate text-xs">
            {report.project}
            {report.project && report.prompt && (
              <span className="text-muted-foreground/40"> &bull; </span>
            )}
            {report.prompt}
          </span>
        )}
      </span>

      <ExternalLink className="text-muted-foreground/40 group-hover/report:text-muted-foreground size-3.5 shrink-0 transition-colors" />
    </button>
  );
}

// ============================================================================
// Compaction divider
// ============================================================================

/**
 * The "Compaction" rule that marks where history was summarised. Rendered in two
 * places (the optimistic pass in `SessionChat` and the first turn after a landed
 * compaction, at the head of its `TurnFrame`); they were byte-identical copies,
 * so they live here to stay that way.
 */
export function CompactionDivider(): React.ReactElement {
  return (
    <div className="my-3 flex items-center gap-3 py-4">
      <div className="bg-border h-px flex-1" />
      <div className="bg-muted/80 border-border/60 flex items-center gap-2 rounded-full border px-3 py-1.5">
        <Layers className="text-muted-foreground size-3.5" />
        <span className="text-muted-foreground text-xs font-semibold tracking-wide">
          Compaction
        </span>
      </div>
      <div className="bg-border h-px flex-1" />
    </div>
  );
}

'use client';

/**
 * Variant B — "Activity card".
 *
 * Thesis: a reader does not want a step list, they want to know the agent is
 * working and roughly on what. Every burst of work between two paragraphs
 * collapses into ONE card with a live status line; the step list only exists
 * inside it. Closest to the ChatGPT / Claude "thinking" card.
 *
 * Two shapes, chosen by the model's own `MIN_GROUP_SIZE` boundary:
 *  - 2+ adjacent tool calls (`type: 'group'`) → the hero `ActivityCard`. This
 *    is a real burst — it deserves a title, a live subtitle, and a step count.
 *  - A single tool call (`type: 'tool'`) → `SingleStep`, a lighter inline row.
 *    A full card around one command is more chrome than content; it still
 *    hides the raw command at rest and expands to the real tool output.
 *
 * Deliverables (`show`, images, decks) are never folded — they render via
 * `ToolPartRenderer` directly, outside and after whatever card precedes them.
 */

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import Loading from '@/components/ui/loading';
import { TextShimmer } from '@/components/ui/text-shimmer';
import { ToolPartRenderer } from '@/features/session/tool/tool-renderers';
import { UnifiedMarkdown } from '@/components/markdown/unified-markdown';
import { cn } from '@/lib/utils';
import { type ReasoningPart, type Turn, isTextPart, isToolPart } from '@/ui';
import {
  Brain,
  ChevronRight,
  FilePlus2,
  FileText,
  Globe,
  PenLine,
  Search,
  Sparkles,
  SquareTerminal,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  type ActivityEntry,
  type ActivityKind,
  activityKindForTool,
  buildActivityItems,
  formatActivityDuration,
  isPartRunning,
  summarizeEntries,
} from '../activity-model';
import { activityGroupLabel, humanizeShellStep } from '../humanize';
import { AssistantProse, UserBubble, useTurnParts, useTurns } from './shared';
import type { ChatVariantProps } from './types';

function stepLabel(part: ActivityEntry['part']): string {
  const input = ((part.state as { input?: Record<string, unknown> })?.input ?? {}) as Record<
    string,
    unknown
  >;
  if (part.tool.replace(/^oc-/, '') === 'bash') {
    return humanizeShellStep({
      description: input.description as string | undefined,
      command: input.command as string | undefined,
    });
  }
  const path = (input.filePath ?? input.path ?? input.pattern ?? input.query) as string | undefined;
  const verb = part.tool.replace(/^oc-/, '').replace(/[-_]/g, ' ');
  return path ? `${verb} · ${path.split('/').slice(-1)[0]}` : verb;
}

/** One icon per activity kind — the card's only visual cue for "roughly what". */
const KIND_ICON: Record<ActivityKind, typeof SquareTerminal> = {
  shell: SquareTerminal,
  read: FileText,
  write: FilePlus2,
  edit: PenLine,
  search: Search,
  web: Globe,
  other: Sparkles,
};

/**
 * A single expandable step row — shared shape between the card's step list
 * and the standalone single-tool row. Never shows the raw tool payload at
 * rest, only the humanized label; a click reveals the real `ToolPartRenderer`.
 */
function StepRow({
  entry,
  sessionId,
  iconClassName,
  rowClassName,
}: {
  entry: ActivityEntry;
  sessionId: string;
  iconClassName?: string;
  rowClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const running = isPartRunning(entry.part);
  const label = stepLabel(entry.part);
  const duration = formatActivityDuration(summarizeEntries([entry]).durationMs);
  const kind = activityKindForTool(entry.part.tool);
  const Icon = KIND_ICON[kind];

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <div
          className={cn(
            'group/step hover:bg-muted/50 flex cursor-pointer items-center gap-2 rounded-sm transition-colors select-none',
            rowClassName,
          )}
        >
          <span
            className={cn(
              'bg-muted flex shrink-0 items-center justify-center rounded-sm',
              running && 'animate-pulse-heartbeat',
              iconClassName,
            )}
          >
            <Icon className="text-muted-foreground size-3" />
          </span>
          {running ? (
            <TextShimmer duration={1} spread={2} className="min-w-0 flex-1 truncate text-left text-xs">
              {label}
            </TextShimmer>
          ) : (
            <span className="text-muted-foreground min-w-0 flex-1 truncate text-left text-xs">
              {label}
            </span>
          )}
          {duration && (
            <span className="text-muted-foreground/40 shrink-0 font-mono text-xs tabular-nums">
              {duration}
            </span>
          )}
          <ChevronRight
            className={cn(
              'text-muted-foreground/30 size-3 shrink-0 opacity-0 transition-transform group-hover/step:opacity-100',
              open && 'rotate-90 opacity-100',
            )}
          />
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="pt-1 pb-1.5 pl-1">
          <ToolPartRenderer part={entry.part} sessionId={sessionId} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** A lone tool call. A full card for one step is more chrome than content —
 *  this is the same humanize-at-rest / expand-for-real-output row, just
 *  without a header, count, or duration summary around it. */
function SingleStep({ entry, sessionId }: { entry: ActivityEntry; sessionId: string }) {
  return (
    <StepRow
      entry={entry}
      sessionId={sessionId}
      iconClassName="size-5"
      rowClassName="-mx-1.5 px-1.5 py-1"
    />
  );
}

/**
 * The hero card for a real burst of work (2+ adjacent tool calls).
 *
 * While running: opens itself so the live step list is visible, the current
 * step's label shimmers, and the leading icon breathes — it should feel
 * unmistakably alive. The instant it finishes, it settles back to a closed,
 * compact resting state (unless the reader pinned it open by clicking), which
 * is the calm confirmation that the burst is done.
 */
function ActivityCard({
  kind,
  entries,
  sessionId,
}: {
  kind: ActivityKind;
  entries: ActivityEntry[];
  sessionId: string;
}) {
  const summary = summarizeEntries(entries);
  const duration = formatActivityDuration(summary.durationMs);
  // `activityGroupLabel` already folds the step count into its wording ("Ran 10
  // commands", "6 steps") — that IS the title's step-count telling, so the
  // trailing meta only adds duration instead of repeating the same number.
  const title = activityGroupLabel(summary.counts, summary.running);
  // The running step's own words are the best available "what is it doing
  // right now"; once nothing is running, the last step is what it just did.
  const currentEntry = entries.find((e) => isPartRunning(e.part)) ?? entries[entries.length - 1];
  const current = stepLabel(currentEntry.part);
  const Icon = KIND_ICON[kind];

  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const wasRunning = useRef(summary.running);

  // Auto-open for the live view, auto-settle shut once it's done — but never
  // fight a reader who has already reached out and toggled it themselves.
  useEffect(() => {
    if (summary.running) {
      if (!pinned) setOpen(true);
      wasRunning.current = true;
      return;
    }
    if (wasRunning.current && !pinned) {
      wasRunning.current = false;
      const t = setTimeout(() => setOpen(false), 700);
      return () => clearTimeout(t);
    }
    wasRunning.current = false;
  }, [summary.running, pinned]);

  return (
    <Collapsible
      open={open}
      onOpenChange={(value) => {
        setPinned(true);
        setOpen(value);
      }}
    >
      <div className="bg-popover overflow-hidden rounded-md border">
        <CollapsibleTrigger asChild>
          <div className="hover:bg-muted/40 flex cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors select-none">
            <span
              className={cn(
                'bg-muted flex size-8 shrink-0 items-center justify-center rounded-sm',
                summary.running && 'animate-pulse-heartbeat',
              )}
            >
              <Icon className="text-muted-foreground size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="text-foreground block truncate text-sm font-medium">{title}</span>
              <AnimatePresence mode="wait" initial={false}>
                <motion.span
                  key={currentEntry.part.id}
                  initial={{ opacity: 0, y: 3 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -3 }}
                  transition={{ type: 'spring', duration: 0.3, bounce: 0 }}
                  className="block"
                >
                  {summary.running ? (
                    <TextShimmer duration={1} spread={2} className="block truncate text-xs">
                      {current}
                    </TextShimmer>
                  ) : (
                    <span className="text-muted-foreground block truncate text-xs">{current}</span>
                  )}
                </motion.span>
              </AnimatePresence>
            </span>
            {(summary.running || duration) && (
              <span className="text-muted-foreground/50 flex shrink-0 items-center gap-1.5 text-xs tabular-nums">
                {summary.running && <Loading className="size-3 shrink-0" />}
                {duration && <span>{duration}</span>}
              </span>
            )}
            <ChevronRight
              className={cn(
                'text-muted-foreground/40 size-4 shrink-0 transition-transform',
                open && 'rotate-90',
              )}
            />
          </div>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-border/60 space-y-0.5 border-t px-3 py-2">
            {entries.map((entry) => (
              <StepRow
                key={entry.part.id}
                entry={entry}
                sessionId={sessionId}
                iconClassName="size-4"
                rowClassName="-mx-1.5 px-1.5 py-1"
              />
            ))}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

/**
 * The model's own thinking. Quiet, collapsed, never body text — but never
 * dropped either: a turn whose only assistant output was reasoning would
 * otherwise render as an empty gap.
 */
function ReasoningNote({ parts, streaming }: { parts: ReasoningPart[]; streaming: boolean }) {
  const [open, setOpen] = useState(false);
  const text = useMemo(
    () =>
      parts
        .map((p) => p.text ?? '')
        .join('\n\n')
        .trim(),
    [parts],
  );
  const preview = useMemo(() => text.split('\n').find((line) => line.trim())?.trim() ?? '', [text]);
  if (!text) return null;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <div
          className={cn(
            'group/think hover:bg-muted/50 -mx-1.5 flex cursor-pointer items-center gap-2 rounded-sm px-1.5 py-1',
            'text-muted-foreground/70 hover:text-foreground transition-colors select-none',
          )}
        >
          <Brain
            className={cn(
              'text-muted-foreground/50 size-3.5 shrink-0',
              streaming && 'animate-pulse-heartbeat',
            )}
          />
          <span className="min-w-0 flex-1 truncate text-xs italic">{preview || 'Thinking'}</span>
          {streaming && (
            <Loading variant="spokes" className="text-muted-foreground/50 size-3 shrink-0" />
          )}
          <ChevronRight
            className={cn(
              'size-3 shrink-0 opacity-0 transition-transform group-hover/think:opacity-100',
              open && 'rotate-90 opacity-100',
            )}
          />
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-border/40 mt-1 mb-2 ml-[7px] border-l pl-3">
          <div className="text-muted-foreground/60 space-y-2 text-xs leading-relaxed italic [&_.kortix-markdown]:italic">
            <UnifiedMarkdown content={text} />
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function VariantActivityCard({ messages, sessionId, isBusy }: ChatVariantProps) {
  const turns = useTurns(messages);
  return (
    <div className="space-y-8">
      {turns.map((turn) => (
        <TurnBody key={turn.userMessage.info.id} turn={turn} sessionId={sessionId} isBusy={isBusy} />
      ))}
    </div>
  );
}

function TurnBody({ turn, sessionId, isBusy }: { turn: Turn; sessionId: string; isBusy?: boolean }) {
  const parts = useTurnParts(turn);
  // 'simple' — a burst is a burst, regardless of which tools it mixes.
  const items = buildActivityItems(parts, { density: 'simple' });

  return (
    <div className="space-y-3">
      <UserBubble turn={turn} />
      {items.map((item, index) => {
        switch (item.type) {
          // Reasoning and passthrough used to fall through to `default: null`,
          // which silently deleted the todo checklist, question prompts and
          // sub-agent cards from this variant. Folding work is the thesis;
          // dropping content the reader must see never was.
          case 'reasoning': {
            const streaming = Boolean(isBusy) && index === items.length - 1;
            return <ReasoningNote key={item.key} parts={item.parts} streaming={streaming} />;
          }
          case 'text':
            return (
              <AssistantProse
                key={item.key}
                text={isTextPart(item.part) ? (item.part.text ?? '') : ''}
              />
            );
          case 'group':
            return (
              <ActivityCard
                key={item.key}
                kind={item.kind}
                entries={item.entries}
                sessionId={sessionId}
              />
            );
          case 'tool':
            return <SingleStep key={item.key} entry={item.entry} sessionId={sessionId} />;
          case 'deliverable':
            return <ToolPartRenderer key={item.key} part={item.entry.part} sessionId={sessionId} />;
          case 'passthrough':
            // Todos, questions, sub-agent cards — tools with their own
            // dedicated UI. Never machinery, never folded.
            return isToolPart(item.part) ? (
              <ToolPartRenderer key={item.key} part={item.part} sessionId={sessionId} />
            ) : null;
          default:
            return null;
        }
      })}
    </div>
  );
}

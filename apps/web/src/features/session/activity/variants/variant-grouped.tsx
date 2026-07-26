'use client';

/**
 * Variant A — "Grouped".
 *
 * Thesis: the transcript's structure is right and its volume is wrong. Keep a
 * visible step list, but fold every run of like work into ONE human line, and
 * never print a raw command at rest — only on a further click, inside the
 * existing `ToolPartRenderer`.
 *
 * Uses the same house pattern as the shipped transcript (session-chat.tsx):
 * tinted-free icon + label row, hairline rail on expand. The improvement over
 * today is entirely in the model (`buildActivityItems` fixes the grouping
 * bug) and in restraint — one line per burst of work, a live subtitle instead
 * of a forced-open wall of rows, and reasoning demoted to a quiet aside.
 */

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { UnifiedMarkdown } from '@/components/markdown/unified-markdown';
import Loading from '@/components/ui/loading';
import { ToolPartRenderer } from '@/features/session/tool/tool-renderers';
import { cn } from '@/lib/utils';
import type { ReasoningPart, Turn } from '@/ui';
import { isTextPart, isToolPart } from '@/ui';
import {
  Brain,
  ChevronRight,
  FilePlus2,
  FileText,
  Globe,
  Layers,
  PenLine,
  Search,
  Terminal,
  type LucideIcon,
} from 'lucide-react';
import { useMemo, useState } from 'react';
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

// ============================================================================
// Human labels
// ============================================================================

/** One tool call as the phrase a non-technical reader would use — the same
 *  vocabulary the collapsed group line draws on, so expanding never surprises
 *  with a different voice. */
export function stepLabel(part: ActivityEntry['part']): string {
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

/**
 * The subtitle under a collapsed group — the last step's label, so a reader
 * gets a concrete sense of what just happened without opening anything.
 * Suppressed when it would just repeat the group line (e.g. a single-entry
 * "group" — never happens today, but keeps this honest if MIN_GROUP_SIZE
 * ever changes — or when the label degenerates to the bare tool name).
 */
export function groupSubtitle(mainLabel: string, entries: ReadonlyArray<ActivityEntry>): string {
  if (entries.length === 0) return '';
  const last = stepLabel(entries[entries.length - 1].part);
  if (!last || last === mainLabel) return '';
  return last;
}

const KIND_ICON: Record<ActivityKind, LucideIcon> = {
  shell: Terminal,
  read: FileText,
  write: FilePlus2,
  edit: PenLine,
  search: Search,
  web: Globe,
  other: Layers,
};

/** A folded step never gets to hide the one thing a non-technical reader
 *  actually needs to know went wrong. */
function isErrored(entry: ActivityEntry): boolean {
  return (entry.part.state as { status?: string } | undefined)?.status === 'error';
}

// ============================================================================
// One tool call inside an expanded group — label first, raw output on a
// further click.
// ============================================================================

function ActivityRow({ entry, sessionId }: { entry: ActivityEntry; sessionId: string }) {
  const [open, setOpen] = useState(false);
  const { part } = entry;
  const running = isPartRunning(part);
  const time = (part.state as { time?: { start?: number; end?: number } } | undefined)?.time;
  const duration =
    typeof time?.start === 'number' && typeof time?.end === 'number'
      ? formatActivityDuration(time.end - time.start)
      : '';

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className={cn(
            'group/row -mx-1 flex w-full min-w-0 items-center gap-2 rounded-sm px-1 py-1',
            'text-muted-foreground/70 hover:text-foreground hover:bg-muted-foreground/5',
            'cursor-pointer text-left text-xs transition-colors',
          )}
        >
          <span className="min-w-0 flex-1 truncate">{stepLabel(part)}</span>
          {duration && (
            <span className="text-muted-foreground/40 shrink-0 font-mono text-[11px] tabular-nums">
              {duration}
            </span>
          )}
          {running && <Loading variant="spokes" className="text-muted-foreground/50 size-2.5 shrink-0" />}
          <ChevronRight
            className={cn(
              'size-3 shrink-0 opacity-0 transition-transform group-hover/row:opacity-60',
              open && 'rotate-90 opacity-60',
            )}
          />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="pt-1 pb-1.5 pl-1">
          <ToolPartRenderer part={part} sessionId={sessionId} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * A tool call that never made it into a group — `buildActivityItems` keeps a
 * run of one as its own row rather than manufacturing a "group of 1". It
 * still gets the same treatment as a folded entry: human label at rest, raw
 * command/output only after a click, so the "never visible at rest" rule
 * holds for singles too, not just runs.
 */
function SingleActivity({
  entry,
  kind,
  sessionId,
}: {
  entry: ActivityEntry;
  kind: ActivityKind;
  sessionId: string;
}) {
  const [open, setOpen] = useState(false);
  const { part } = entry;
  const running = isPartRunning(part);
  const time = (part.state as { time?: { start?: number; end?: number } } | undefined)?.time;
  const duration =
    typeof time?.start === 'number' && typeof time?.end === 'number'
      ? formatActivityDuration(time.end - time.start)
      : '';
  const Icon = KIND_ICON[kind];

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <div
          className={cn(
            'group/act -mx-1 flex items-center gap-2 rounded-sm px-1 py-1',
            'text-muted-foreground/80 hover:text-foreground hover:bg-muted-foreground/5',
            'cursor-pointer transition-colors select-none',
          )}
        >
          <Icon className={cn('text-muted-foreground/50 size-3.5 shrink-0', running && 'animate-pulse-heartbeat')} />
          <span className="min-w-0 flex-1 truncate text-xs font-medium">{stepLabel(part)}</span>
          {duration && (
            <span className="text-muted-foreground/40 shrink-0 font-mono text-[11px] tabular-nums">
              {duration}
            </span>
          )}
          {running && <Loading variant="spokes" className="text-muted-foreground/50 size-3 shrink-0" />}
          <ChevronRight
            className={cn(
              'size-3 shrink-0 opacity-0 transition-transform group-hover/act:opacity-100',
              open && 'rotate-90 opacity-100',
            )}
          />
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-border/40 mt-1.5 mb-2 ml-[7px] border-l pl-3">
          <ToolPartRenderer part={part} sessionId={sessionId} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// ============================================================================
// The collapsed group line — the product.
// ============================================================================

function ActivityGroup({
  kind,
  entries,
  sessionId,
}: {
  kind: ActivityKind;
  entries: ActivityEntry[];
  sessionId: string;
}) {
  // Auto-opening a live group was considered and rejected: forcing the row
  // open mid-burst would flash a wall of raw steps for exactly as long as the
  // burst runs — the failure this variant exists to fix. The label switching
  // to "Running…" plus the live subtitle already say "working, here's what",
  // without asking the reader to watch a terminal scroll. Users can still
  // open it themselves at any time, running or not.
  const [open, setOpen] = useState(false);
  const summary = summarizeEntries(entries);
  const duration = formatActivityDuration(summary.durationMs);
  const label = activityGroupLabel(summary.counts, summary.running);
  const subtitle = open ? '' : groupSubtitle(label, entries);
  const Icon = KIND_ICON[kind];
  const failedCount = useMemo(() => entries.filter(isErrored).length, [entries]);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <div
          className={cn(
            'group/act -mx-1 flex items-start gap-2 rounded-sm px-1 py-1',
            'text-muted-foreground/80 hover:text-foreground hover:bg-muted-foreground/5',
            'cursor-pointer transition-colors select-none',
          )}
        >
          <Icon
            className={cn(
              'mt-0.5 size-3.5 shrink-0',
              failedCount > 0 ? 'text-kortix-red' : 'text-muted-foreground/50',
              summary.running && 'animate-pulse-heartbeat',
            )}
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  'min-w-0 flex-1 truncate text-xs font-medium',
                  failedCount > 0 && 'text-kortix-red',
                )}
              >
                {label}
              </span>
              {failedCount > 0 && (
                <span className="text-kortix-red shrink-0 text-[11px] font-medium">
                  {failedCount === entries.length ? 'Failed' : `${failedCount} failed`}
                </span>
              )}
              {duration && (
                <span className="text-muted-foreground/40 shrink-0 font-mono text-[11px] tabular-nums">
                  {duration}
                </span>
              )}
              {summary.running && (
                <Loading variant="spokes" className="text-muted-foreground/50 size-3 shrink-0" />
              )}
              <ChevronRight
                className={cn(
                  'size-3 shrink-0 opacity-0 transition-transform group-hover/act:opacity-100',
                  open && 'rotate-90 opacity-100',
                )}
              />
            </div>
            {subtitle && (
              <div className="text-muted-foreground/50 mt-0.5 truncate text-[11px]">{subtitle}</div>
            )}
          </div>
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-border/40 mt-1.5 mb-2 ml-[7px] space-y-0.5 border-l pl-3">
          {entries.map((entry) => (
            <ActivityRow key={entry.part.id} entry={entry} sessionId={sessionId} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// ============================================================================
// Reasoning — a quiet collapsible, never body text.
// ============================================================================

function ReasoningBlock({ parts, streaming }: { parts: ReasoningPart[]; streaming: boolean }) {
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
            'group/think -mx-1 flex items-center gap-2 rounded-sm px-1 py-1',
            'text-muted-foreground/70 hover:text-foreground hover:bg-muted-foreground/5',
            'cursor-pointer transition-colors select-none',
          )}
        >
          <Brain
            className={cn('text-muted-foreground/50 size-3.5 shrink-0', streaming && 'animate-pulse-heartbeat')}
          />
          <span className="min-w-0 flex-1 truncate text-xs italic">{preview || 'Thinking'}</span>
          {streaming && <Loading variant="spokes" className="text-muted-foreground/50 size-3 shrink-0" />}
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

// ============================================================================
// Turn
// ============================================================================

export function VariantGrouped({ messages, sessionId, isBusy }: ChatVariantProps) {
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
  const items = buildActivityItems(parts, { density: 'detailed' });

  return (
    <div className="space-y-1.5">
      <UserBubble turn={turn} />
      <div className="space-y-1.5">
        {items.map((item, index) => {
          switch (item.type) {
            case 'reasoning': {
              // Only the very last reasoning block in a still-streaming turn
              // can possibly be mid-thought — every earlier one already
              // finished by definition of being earlier in the list.
              const streaming = Boolean(isBusy) && index === items.length - 1;
              return <ReasoningBlock key={item.key} parts={item.parts} streaming={streaming} />;
            }
            case 'text':
              return (
                <AssistantProse
                  key={item.key}
                  className="py-1"
                  text={isTextPart(item.part) ? (item.part.text ?? '') : ''}
                />
              );
            case 'group':
              return (
                <ActivityGroup
                  key={item.key}
                  kind={item.kind}
                  entries={item.entries}
                  sessionId={sessionId}
                />
              );
            case 'tool':
              // A failed step is never worth a click to discover — render it
              // via ToolPartRenderer directly, which already gives errors
              // their own visible "failed" card instead of a raw command.
              return isErrored(item.entry) ? (
                <ToolPartRenderer key={item.key} part={item.entry.part} sessionId={sessionId} />
              ) : (
                <SingleActivity
                  key={item.key}
                  entry={item.entry}
                  kind={activityKindForTool(item.entry.part.tool)}
                  sessionId={sessionId}
                />
              );
            case 'deliverable':
              return <ToolPartRenderer key={item.key} part={item.entry.part} sessionId={sessionId} />;
            case 'passthrough':
              // Todos, questions, sub-agent cards — tools with their own
              // dedicated UI. They are never machinery to fold away.
              return isToolPart(item.part) ? (
                <ToolPartRenderer key={item.key} part={item.part} sessionId={sessionId} />
              ) : null;
            default:
              return null;
          }
        })}
      </div>
    </div>
  );
}

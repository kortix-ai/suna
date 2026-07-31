'use client';

/** One row inside a burst: icon, verb, object, and the tool's own result. */

import {
  BrainIcon,
  FileTextIcon,
  FolderOpenIcon,
  GlobeIcon,
  MagnifyingGlassIcon,
  PencilSimpleIcon,
  StackIcon,
  TerminalIcon,
  UsersThreeIcon,
} from '@phosphor-icons/react';

import { ToolPartRenderer } from '@/features/session/tool/tool-renderers';
import { cn } from '@/lib/utils';
import { isReasoningPart, isToolPart, type Part } from '@/ui';
import { normalizeActivityToolName } from '../session-activity-groups';
import { stepLabel } from './step-label';
import { ThrottledMarkdown } from './throttled-markdown';

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  read: FileTextIcon,
  write: PencilSimpleIcon,
  edit: PencilSimpleIcon,
  apply_patch: PencilSimpleIcon,
  bash: TerminalIcon,
  glob: MagnifyingGlassIcon,
  grep: MagnifyingGlassIcon,
  list: FolderOpenIcon,
  web_search: GlobeIcon,
  websearch: GlobeIcon,
  webfetch: GlobeIcon,
  web_fetch: GlobeIcon,
  scrape: GlobeIcon,
  scrape_webpage: GlobeIcon,
  task: UsersThreeIcon,
};

function iconFor(part: Part) {
  if (isReasoningPart(part)) return BrainIcon;
  if (!isToolPart(part)) return StackIcon;
  return ICONS[normalizeActivityToolName(part.tool)] ?? StackIcon;
}

export function ActivityStep({
  part,
  sessionId,
  running,
  disableNavigation,
}: {
  part: Part;
  sessionId: string;
  running: boolean;
  disableNavigation?: boolean;
}) {
  const label = stepLabel(part);
  const Icon = iconFor(part);
  const verb = running ? label.running : label.verb;

  if (isReasoningPart(part)) {
    const text = part.text?.trim();
    if (!text) return null;
    // The thought IS the row — no verb label above it. The summary line at the
    // top of the burst is the muted layer; these read at primary weight so the
    // eye lands on what the agent actually concluded. Wraps rather than
    // truncates: a half-sentence of reasoning is worse than none.
    // mt-[3px] centres the 14px glyph on the first 20px line, optically rather
    // than geometrically.
    return (
      <div className="flex min-w-0 gap-2">
        <Icon className="text-muted-foreground/50 mt-[3px] size-3.5 flex-none" />
        {/*
				  A thought is prose, not a document. The shared markdown renderer
				  ships document typography — 15px body, weight-600 strong, space-y-4
				  between blocks — which turns a bold lead-in into a heading and breaks
				  the chain's vertical rhythm. Pull it back to row scale so every step
				  reads at the same weight.
				*/}
        <div
          className={cn(
            'text-foreground/90 min-w-0 flex-1 text-sm text-pretty',
            '[&_.kortix-markdown]:!text-sm',
            // Blocks carry `my-4`; the container carries `space-y-4`. Both are
            // margin-top, so zeroing one loses to the other. Zero every block
            // margin and re-space with flex gap instead of fighting over it.
            '[&_.kortix-markdown_div]:!my-0',
            '[&_.kortix-markdown>div]:!flex [&_.kortix-markdown>div]:!flex-col',
            '[&_.kortix-markdown>div]:!gap-1.5',
            '[&_strong]:!font-medium',
          )}
        >
          <ThrottledMarkdown content={text} isStreaming={false} />
        </div>
      </div>
    );
  }

  const header = (
    <div className="flex min-w-0 items-center gap-2">
      <Icon className="text-muted-foreground/60 size-3.5 flex-none" />
      <span className="text-foreground/80 flex-none text-xs">{verb}</span>
      {label.object && (
        <span
          className={cn('text-muted-foreground/70 min-w-0 truncate font-mono text-xs')}
          title={label.object}
        >
          {label.object}
        </span>
      )}
    </div>
  );

  if (!isToolPart(part)) {
    // Genuinely unknown part types are neither tool nor reasoning, but the
    // turn modules share a "never silently drop a part" policy (stepLabel
    // falls back to a generic 'Used'/'Using' label rather than omitting it).
    // There is no tool state to render, so this is the label row only.
    return <div className="min-w-0">{header}</div>;
  }

  // The tool's own renderer is the row: it draws its own icon, title, subtitle,
  // and duration, and is itself expandable for the full output. A label row on
  // top of it would just repeat the same step in different words.
  return (
    <div className="min-w-0">
      <ToolPartRenderer part={part} sessionId={sessionId} disableNavigation={disableNavigation} />
    </div>
  );
}

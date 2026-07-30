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

import { StepsItem } from '@/components/ui/steps';
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
    return (
      <StepsItem className="flex min-w-0 gap-2">
        <Icon className="text-muted-foreground/60 mt-0.5 size-3.5 flex-none" />
        <div className="min-w-0 flex-1">
          <span className="text-foreground/80 text-xs">{verb}</span>
          <div className="text-muted-foreground/70 mt-0.5 text-xs italic">
            <ThrottledMarkdown content={text} isStreaming={false} />
          </div>
        </div>
      </StepsItem>
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
    return <StepsItem className="min-w-0">{header}</StepsItem>;
  }

  return (
    <StepsItem className="min-w-0">
      {header}
      {/* The tool's own renderer supplies results (sources, diffs, output). */}
      <div className="mt-1">
        <ToolPartRenderer part={part} sessionId={sessionId} disableNavigation={disableNavigation} />
      </div>
    </StepsItem>
  );
}

'use client';

/** One row inside a burst: icon, verb, object, and the tool's own result. */

import {
  FileTextIcon,
  FolderOpenIcon,
  GlobeIcon,
  MagnifyingGlassIcon,
  PencilSimpleIcon,
  StackIcon,
  TerminalWindowIcon,
  UsersThreeIcon,
} from '@phosphor-icons/react';

import { ToolPartRenderer } from '@/features/session/tool/tool-renderers';
import { cn } from '@/lib/utils';
import { isToolPart, type Part } from '@/ui';
import { normalizeActivityToolName } from '../session-activity-groups';
import { stepLabel } from './step-label';

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  read: FileTextIcon,
  write: PencilSimpleIcon,
  edit: PencilSimpleIcon,
  apply_patch: PencilSimpleIcon,
  bash: TerminalWindowIcon,
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

  const header = (
    <div className="flex min-w-0 items-center gap-3">
      <Icon className="text-muted-foreground size-4 flex-none" />
      <span className="text-foreground/80 flex-none text-sm leading-[1.5]">{verb}</span>
      {label.object && (
        <span
          className={cn(
            'text-muted-foreground/70 min-w-0 truncate font-mono text-sm leading-[1.5]',
          )}
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
  //
  // The overrides below touch only the trigger LABEL — icon, title, subtitle,
  // args, badge, duration — never the expanded content underneath (a code
  // viewer, terminal output, a search-result list). Those already carry their
  // own considered typography; forcing them to this row's scale would bloat a
  // code block and blur the density that makes long output scannable. Scoped
  // to `[data-component='tool-trigger']` so the Action Panel and /debug/tools,
  // which render the exact same tool components, are untouched — this is a
  // reading of the chain, not a change to the tool.
  //
  // A trigger favicon (web fetch) is 20px where every other step leads with a
  // 16px stroke icon, so left alone it sits wider than its neighbours and the
  // connector line reads as crooked. Pull it to 16px — but only in the trigger.
  // Source rows nested inside the results card are a separate surface with
  // their own alignment, and shrinking their favicons to match the chain would
  // make the card look starved.
  return (
    <div
      className={cn(
        'min-w-0',
        "[&_[data-component='tool-trigger']]:!gap-3",
        "[&_[data-component='tool-trigger']>span:first-child>svg]:!size-4",
        "[&_[data-component='tool-trigger']_span]:!text-sm",
        "[&_[data-component='tool-trigger']_span]:!leading-[1.5]",
        "[&_[data-component='tool-trigger']_[data-slot='favicon-avatar']]:!size-4",
        "[&_[data-component='tool-trigger']_[data-slot='favicon-avatar']_svg]:!size-2.5",
      )}
    >
      <ToolPartRenderer part={part} sessionId={sessionId} disableNavigation={disableNavigation} />
    </div>
  );
}

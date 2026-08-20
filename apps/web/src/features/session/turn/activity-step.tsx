'use client';

/** One row inside a burst: icon, verb, object, and the tool's own result. */

import {
  FilesIcon,
  FolderOpenIcon,
  GlobeIcon,
  MagnifyingGlassIcon,
  PencilSimpleIcon,
  ReadCvLogoIcon,
  StackIcon,
  TerminalWindowIcon,
  UsersThreeIcon,
} from '@phosphor-icons/react';

import { familyForTool } from '@/features/session/action-panel/shared/narration';
import { partOutcome } from '@/features/session/tool/shared/tool-outcome';
import { ToolPartRenderer } from '@/features/session/tool/tool-renderers';
import { cn } from '@/lib/utils';
import { isToolPart, type Part } from '@/ui';
import { memo } from 'react';
import { normalizeActivityToolName } from '../session-activity-groups';
import { stepLabel } from './step-label';

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  read: ReadCvLogoIcon,
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
  // Without an entry here `skill` fell through to the generic `StackIcon`
  // fallback — the same mark every unrecognised tool gets, so a skills row said
  // nothing more than "some tool ran". `Files` is stacked pages: several of a
  // thing, which is exactly what a grouped skills row is.
  skill: FilesIcon,
};

/** Exported so a group row can lead with the same glyph its members carry. */
export function iconFor(part: Part) {
  if (!isToolPart(part)) return StackIcon;
  return ICONS[normalizeActivityToolName(part.tool)] ?? StackIcon;
}

function ActivityStepImpl({
  part,
  sessionId,
  running,
  disableNavigation,
  bare,
}: {
  part: Part;
  sessionId: string;
  running: boolean;
  disableNavigation?: boolean;
  /**
   * This row is the WHOLE burst — no summary line above it, no siblings, no
   * chain rail. See `ActivityBurst`.
   */
  bare?: boolean;
}) {
  const label = stepLabel(part);
  const Icon = iconFor(part);
  const verb = running ? label.running : label.verb;

  /**
   * A bare row drops its leading glyph.
   *
   * The family icon is not a label — it is the rail's anchor. `ChainOfThought`
   * runs its connector down the centre of that 16px gutter (`left-2`), so the
   * icons are what make a chain read as one thread rather than as loose lines.
   * A single row has no rail and no thread, so the glyph is left holding a
   * column that no longer exists, and it pushes the only words on the row 28px
   * off the margin every other line of the turn starts at.
   *
   * The OUTCOME mark is not dropped, and that is the whole subtlety: on a bare
   * row it is the only failure signal left — the summary line that said
   * "1 step failed" and the chain's closing step are both gone. `partOutcome`
   * decides, not `state.status`, so a call that RETURNED its error keeps its
   * mark too.
   *
   * Neither is a DELEGATE row's glyph, for the reason the paragraph above gives
   * and not despite it. "A single row has no rail and no thread" is true of a
   * read or a command; it is false of a sub-agent. `task` / `agent_spawn` /
   * `session_spawn` render a nested thread of their own — the sub-agent's steps,
   * with their own hairline (`tool/shared/sub-agent.tsx`) — so the row IS a
   * parent, and the icon is that thread's anchor exactly as it is in the chain.
   * Stripping it left a lone sub-agent's twenty rows hanging off a line of bare
   * text. The family table decides rather than a local list of tool names, so a
   * new delegation alias cannot land on one side of this and not the other.
   */
  const hideIcon =
    Boolean(bare) &&
    (!isToolPart(part) || partOutcome(part) === 'ok') &&
    !(isToolPart(part) && familyForTool(part.tool) === 'delegate');

  const header = (
    <div className="flex min-w-0 items-center gap-3">
      {!hideIcon && <Icon className="text-muted-foreground size-4 flex-none" />}
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
        // The tool's leading glyph lives in the trigger's first span
        // (`ToolHeaderRow`'s `leading`). Scoped to the trigger, so the expanded
        // content — and the Action Panel rendering the same component — keep
        // theirs. `hideIcon` has already spared the outcome mark.
        hideIcon && "[&_[data-component='tool-trigger']>span:first-child]:hidden",
        // The gap above moves the trigger's TEXT column; this moves the card
        // under it to the same place. `TOOL_INDENT` derives 22px from the row's
        // native `gap-1.5`, so overriding the gap and not the indent is what
        // left an expanded command's block 6px left of every other row's
        // content in the same chain. One override is half an override.
        //
        // 1.75rem = the 16px icon + the 12px `gap-3` above. A bare row hides the
        // icon but keeps this: the chain rail still runs at `left-2`, so a card
        // at the margin would have the hairline cutting through it.
        '[--tool-indent:1.75rem]',
      )}
    >
      <ToolPartRenderer part={part} sessionId={sessionId} disableNavigation={disableNavigation} />
    </div>
  );
}

/**
 * Every prop here is a scalar or the part itself, and a part keeps its identity
 * until it changes — so the default shallow compare is exactly right, and this
 * is the boundary that stops a settled tool row (and its shiki-highlighted
 * card) from re-rendering on every frame of the turn it sits in.
 */
export const ActivityStep = memo(ActivityStepImpl);
ActivityStep.displayName = 'ActivityStep';

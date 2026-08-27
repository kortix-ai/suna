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
}: {
  part: Part;
  sessionId: string;
  running: boolean;
  disableNavigation?: boolean;
}) {
  const label = stepLabel(part);
  const Icon = iconFor(part);
  const verb = running ? label.running : label.verb;

  /**
   * EVERY row keeps its leading glyph, single-step bursts included.
   *
   * A lone row used to drop it. The reasoning was geometric — the family icon
   * anchors the chain rail `ChainOfThought` runs down that 16px gutter
   * (`left-2`), and one row has no chain — and it cost the row the only thing
   * that names WHICH tool ran at a glance. A lone write rendered as a line of
   * text with nothing on it: no pencil, no terminal, nothing to tell it apart
   * from the row above at a glance, and the tool's own name is not always in
   * the words ("Write" is, "Ran command" is not).
   *
   * The glyph is not decoration on this surface, it is the row's identity, and
   * a turn made of single-call bursts is exactly the case where the reader has
   * the least other context. The 28px lane it holds is the same lane every
   * other row's content sits in and the same lane `--tool-indent` puts the
   * expanded card in, so keeping it is also what keeps a bare row aligned with
   * the chain rows around it.
   */

  const header = (
    <div className="flex min-w-0 items-center gap-3">
      <Icon className="text-muted-foreground size-4 flex-none" />
      <span className="text-foreground/80 flex-none text-sm leading-[1.5]">{verb}</span>
      {label.object && (
        <span
          className="text-muted-foreground/70 min-w-0 truncate font-mono text-sm leading-[1.5]"
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
        // The gap above moves the trigger's TEXT column; this moves the card
        // under it to the same place. `TOOL_INDENT` derives 22px from the row's
        // native `gap-1.5`, so overriding the gap and not the indent is what
        // left an expanded command's block 6px left of every other row's
        // content in the same chain. One override is half an override.
        //
        // 1.75rem = the 16px icon + the 12px `gap-3` above, so the card lands
        // in the same column as the row's words. The chain rail runs at
        // `left-2`, so a card at the margin would have the hairline cutting
        // through it.
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

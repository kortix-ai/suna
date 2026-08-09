'use client';

/**
 * A run of reads or writes rendered as FILES rather than as tool cards.
 *
 * A `read` row today is a `BasicTool` disclosure that opens a code viewer inside
 * the chat column — a tool reporting on itself. But the user already has a
 * first-class file surface on this very screen: the attachment tile on their own
 * message, which opens the file in the right-hand detail panel. A file the agent
 * opened and a file the user attached are the same object, so they get the same
 * shape and the same click. That is the whole idea of this module.
 *
 * `edit` / `apply_patch` are deliberately NOT here. Their renderer shows a diff,
 * which is the right output for a change; this is a rule about whole files the
 * agent opened or produced, not about edits.
 */

import { CaretRightIcon, WarningIcon } from '@phosphor-icons/react';

import { DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import { STATUS_TEXT } from '@/components/ui/status';
import { TextShimmer } from '@/components/ui/text-shimmer';
import {
  partOutcome,
  partOutput,
  partStreamingInput,
} from '@/features/session/tool/shared/infrastructure';
import { parseReadOutput } from '@/features/session/tool/shared/read-helpers';
import { useOcFileOpen } from '@/features/session/use-oc-file-open';
import { cn } from '@/lib/utils';
import { fileIconFor, getFilename, getFileType, getTypeLabel } from '@/lib/utils/file-utils';
import { useFilePreviewStore } from '@/stores/file-preview-store';
import { isToolPart, type Part, type ToolPart } from '@/ui';
import { memo } from 'react';
import { normalizeActivityToolName } from '../session-activity-groups';

import { ActivityStep, iconFor } from './activity-step';
import { samePartsList } from './same-parts';

interface FileVerb {
  /** Past tense, shown once the run has settled. */
  verb: string;
  /** Present participle, shown while a member is still in flight. */
  running: string;
}

const FILE_CHIP_TOOLS: ReadonlyMap<string, FileVerb> = new Map([
  ['read', { verb: 'Read', running: 'Reading' }],
  ['write', { verb: 'Wrote', running: 'Writing' }],
]);

/** Input keys a file tool may carry its path under, in resolution order. */
const PATH_KEYS = ['filePath', 'path', 'file'] as const;

/**
 * True when this part is a whole-file read or write, i.e. eligible for a chip.
 *
 * `normalizeActivityToolName` is the same door `activity-step.tsx` and
 * `step-label.ts` go through, so an MCP id, an `oc-` alias and the bare name all
 * resolve to the one family here too.
 */
export function isFileChipPart(part: Part): boolean {
  return isToolPart(part) && FILE_CHIP_TOOLS.has(normalizeActivityToolName(part.tool));
}

/**
 * The path this call touched, or undefined while the input is still arriving.
 *
 * Reads through `partStreamingInput` for the same reason `read-tool.tsx` does: a
 * call mid-stream has its arguments in `state.raw` and nothing in `state.input`,
 * so reading `input` alone leaves a chip pathless for the whole time it is most
 * interesting.
 */
function chipPath(part: ToolPart): string | undefined {
  const input = partStreamingInput(part);
  for (const key of PATH_KEYS) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * True when this call resolved to a DIRECTORY rather than to a whole file.
 *
 * `read` legitimately lists a directory: `parseReadOutput` returns
 * `type: 'directory'` and `read-tool.tsx` renders the entry list. A chip would
 * divert that listing into a file preview aimed at a folder — and, with a
 * trailing slash, `getFilename` degrades to the literal string "file", so the
 * chip would be labelled `file` / `File`. A directory falls through to its own
 * renderer instead. The slash clause carries the same call while its output is
 * still arriving, when `partOutput` is empty by construction.
 */
function isDirectoryTarget(part: ToolPart, path: string): boolean {
  if (path.endsWith('/')) return true;
  return parseReadOutput(partOutput(part))?.type === 'directory';
}

function isInFlight(part: ToolPart): boolean {
  const status = part.state.status;
  return status === 'pending' || status === 'running';
}

/**
 * One file: icon plate, name, type.
 *
 * Horizontal rather than the user-message square tile because these sit in a
 * text column under a label, not in a right-aligned block — a row of squares
 * would read as a second gallery hanging off the chain. The name gets the whole
 * first line at `text-sm font-medium`, which is the point: filenames are what
 * distinguishes one of these from the next, and the square tile has to clamp
 * them to two cramped lines to fit.
 *
 * Hover / press / transition are `ATTACHMENT_INTERACTIVE`'s three parts, matched
 * value for value (`user-message.tsx`) so the agent's files answer the pointer
 * exactly like the user's do — including the 0.97 press, because two press
 * depths on one screen is what that shared constant exists to prevent.
 *
 * The icon plate carries no border and no `rounded-md`. The chip is already a
 * rounded, bordered box and the plate sits 8px inside it, so a second hairline
 * at the same radius is the nested rounding the design system bans outright,
 * and it reads as a one-off card rather than as an attachment. Tint alone draws
 * it, at the design system's `rounded-sm` plate / `size-9` box / `size-5` glyph
 * proportions. The tint is `bg-muted` at full strength and not `bg-muted/50`
 * because the chip's own hover IS `bg-muted/50` — a plate at that value would
 * disappear under the pointer.
 */
function FileChipImpl({ path, onOpen }: { path: string; onOpen: (path: string) => void }) {
  const filename = getFilename(path);
  const type = getFileType(filename);
  // The glyph for THIS file, not for its category — a .ts, a .png and a .zip
  // used to share one anonymous mark.
  const Icon = fileIconFor(filename);
  // `getFileType` enumerates twelve groups, so `.yml`, `.sh`, `.go`, `.rs`,
  // `.toml` and most of a real repo collapse to the literal word "File" — a
  // second line that costs 16px and says nothing. The extension itself is the
  // information; "File" survives only for a name that genuinely has none.
  const ext = filename.includes('.') ? filename.split('.').pop() : undefined;
  const typeLabel = getTypeLabel(type, ext);

  return (
    <li>
      <button
        type="button"
        title={path}
        aria-label={`Open ${filename}`}
        onClick={() => onOpen(path)}
        className={cn(
          'border-border bg-background hover:bg-muted/50 focus-visible:ring-ring/50 flex max-w-full cursor-pointer items-center gap-3 rounded-md border p-1.5 py-1 pr-3 shadow-xs transition-colors focus-visible:ring-2 focus-visible:outline-none active:scale-[0.97]',
        )}
      >
        <span className="bg-muted flex size-9 flex-none items-center justify-center rounded-sm">
          <Icon className="text-muted-foreground size-5" />
        </span>
        <span className="flex min-w-0 flex-col text-left">
          <span className="text-foreground truncate text-sm font-medium">{filename}</span>
          <span className="text-muted-foreground truncate text-xs">
            {typeLabel === 'File' && ext ? ext.toUpperCase() : typeLabel}
          </span>
        </span>
      </button>
    </li>
  );
}

/**
 * A run of file calls: one summary row that opens to the files themselves.
 *
 * `mergeBurstSteps` unwraps a run of one into a flat `part` row, which is right
 * for a shell command and wrong here — the point of this row is that a read is a
 * FILE, and one file is still a file. So the decision to draw chips is made at
 * render time in `ActivityBurst` rather than in the merge, and this component
 * accepts one part as happily as nine. `mergeBurstSteps` stays pure.
 *
 * The trigger is a copy of `ActivityGroupStep`'s, not a shared component: the
 * two rows are four lines of JSX apart and they differ in exactly one place —
 * the body. Extracting the 90% that matches would hide the 10% that is the whole
 * reason this file exists.
 *
 * The count in the label is the count of things below it. Not the number of
 * parts: a file read twice is one chip, so a label counting parts would promise
 * two files and open to one. `burstSummary` and `mergeBurstSteps` share this
 * discipline — every reader of a burst agrees on what is in it, or a reader goes
 * hunting for a row that was never rendered.
 *
 * Failed calls are not chips. A file that could not be read has nothing to
 * preview, and a chip that opens an empty panel is worse than no chip. They fall
 * through to ordinary `ActivityStep` rows under the chips, so the error card is
 * still one click away.
 */
function ActivityFileChipStepImpl({
  parts,
  running,
  sessionId,
  disableNavigation,
  bare,
}: {
  parts: ReadonlyArray<Part>;
  /** The burst is still working — passed down to the fallback rows. */
  running: boolean;
  sessionId: string;
  disableNavigation?: boolean;
  /** This row is the WHOLE burst — see `ActivityBurst`. */
  bare?: boolean;
}) {
  const openPreview = useFilePreviewStore((s) => s.openPreview);
  // Called before every early return below — hook order is not negotiable.
  // This is the same door `read-tool.tsx` uses, and it reads the SHARED query
  // cache rather than issuing its own request; a chip row also replaces the N
  // read rows that each paid for this hook individually.
  const { toDisplayPath } = useOcFileOpen();

  const first = parts[0];
  const family =
    first && isToolPart(first)
      ? FILE_CHIP_TOOLS.get(normalizeActivityToolName(first.tool))
      : undefined;

  const paths: string[] = [];
  const fallbacks: Part[] = [];
  let failedCount = 0;
  let inFlight = false;

  for (const part of parts) {
    if (!isToolPart(part)) {
      fallbacks.push(part);
      continue;
    }
    if (isInFlight(part)) inFlight = true;
    // Read the verdict with the same predicate `burstFailureCount` uses, so a
    // call that RETURNED its error ("Error: ENOENT", the `{success:false}`
    // contract) is a failure here too — `state.status === 'error'` alone would
    // hand a chip to a read that never opened anything.
    if (partOutcome(part) !== 'ok') {
      failedCount += 1;
      fallbacks.push(part);
      continue;
    }
    const path = chipPath(part);
    if (!path || isDirectoryTarget(part, path)) {
      fallbacks.push(part);
      continue;
    }
    if (!paths.includes(path)) paths.push(path);
  }

  if (!family) return null;

  /**
   * A bare row with no chips is a door onto nothing.
   *
   * The single call failed, or read a directory, or has no path yet — so it
   * produced no chip, and "Read 1 file" would open to the one tool row already
   * sitting behind it. Two clicks, two labels, one call. Drop the row and let
   * the tool render itself, which is exactly what a bare single `bash` does.
   */
  if (bare && paths.length === 0) {
    return (
      <>
        {fallbacks.map((part) => (
          <ActivityStep
            key={part.id}
            part={part}
            bare
            sessionId={sessionId}
            running={running}
            disableNavigation={disableNavigation}
          />
        ))}
      </>
    );
  }

  // Running wins over error, the same precedence `groupSteps.statusOf` applies:
  // a run with one dead call and one still in flight has not finished failing.
  const status = inFlight ? 'running' : failedCount > 0 ? 'error' : 'done';
  const count = paths.length + fallbacks.length;
  // The verdict goes in the WORDS as well as the glyph. `Wrote 2 files` over a
  // run where one write died is the row claiming both landed — the exact lie
  // `group-steps.ts` forbids by routing a failed group through
  // `narrateFailedStep`. The clause is the collapsed title's, character for
  // character (`burst-summary.ts`): lower-case, factual, no adjective, so one
  // burst speaks with one vocabulary. Suppressed while running for the same
  // reason the title suppresses it — a count mid-flight is a snapshot the next
  // frame contradicts.
  // ONE file names itself. "Read 1 file" spends a whole row saying "one" when
  // the row could say WHICH — and the reader then has to open it to find out.
  // Only when the run is a clean single chip: a fallback in the run means the
  // path on the label would not be the path that failed.
  const object =
    count === 1 && paths.length === 1
      ? toDisplayPath(paths[0])
      : `${count} ${count === 1 ? 'file' : 'files'}`;
  const label =
    `${status === 'running' ? family.running : family.verb} ${object}` +
    (status === 'error' ? ` · ${failedCount} failed` : '');
  const Icon = iconFor(parts[0]);

  return (
    <>
      {/* One child only — DisclosureTrigger clones each child into its own
			    clickable node, so a sibling caret would stack as a separate row. */}
      <DisclosureTrigger>
        <div
          data-status={status}
          className={cn(
            'text-foreground/80 hover:text-foreground',
            'flex w-full cursor-pointer items-center gap-3',
            'text-left text-sm leading-[1.5] transition-colors',
          )}
        >
          {/* A bare row drops the family glyph: the icon is the chain rail's
              anchor (`left-2`), and a single row has no rail to anchor. The
              failure mark stays — on a bare row it is the only verdict left,
              since the burst's summary line and closing step are both gone. */}
          {status === 'error' ? (
            <>
              {/* Closed: failure mark replaces the family glyph. Open: the
                  failed rows carry their own verdicts, so the trigger falls
                  back to the family icon and drops the duplicate warning. */}
              <WarningIcon
                weight="fill"
                aria-label="This step failed"
                className={cn(
                  'size-4 flex-none',
                  !bare && 'group-data-[state=open]/step:hidden',
                  STATUS_TEXT.destructive,
                )}
              />
              {!bare && (
                <Icon className="text-muted-foreground hidden size-4 flex-none group-data-[state=open]/step:block" />
              )}
            </>
          ) : (
            !bare && <Icon className="text-muted-foreground size-4 flex-none" />
          )}
          {status === 'running' ? (
            <TextShimmer className="min-w-0 truncate leading-[1.5] font-medium">
              {label}
            </TextShimmer>
          ) : (
            <span className="min-w-0 truncate font-medium">{label}</span>
          )}
          <CaretRightIcon
            className={cn(
              'text-muted-foreground/40 size-3.5 flex-none',
              'transition-transform group-data-[state=open]/step:rotate-90',
            )}
          />
        </div>
      </DisclosureTrigger>
      <DisclosureContent>
        {/* `pl-7` puts the files under the LABEL (size-4 icon + gap-3), clear of
				    the chain rail at `left-2` — the indent is what says they belong to
				    the row above rather than to the chain. */}
        {/* The indent survives a bare row even though the icon it was measured
					  from does not. The chain rail runs at `left-2`, so content flush to
					  the margin puts the hairline 8px inside it — straight through the
					  left edge of the first chip. 28px is the lane the rail needs. */}
        <div className="mt-3 space-y-3 pl-7">
          {paths.length > 0 && (
            <ul className="flex flex-wrap gap-2">
              {paths.map((path) => (
                <FileChip key={path} path={path} onOpen={openPreview} />
              ))}
            </ul>
          )}
          {fallbacks.length > 0 && (
            <div className="space-y-3">
              {fallbacks.map((part) => (
                <ActivityStep
                  key={part.id}
                  part={part}
                  sessionId={sessionId}
                  running={running}
                  disableNavigation={disableNavigation}
                />
              ))}
            </div>
          )}
        </div>
      </DisclosureContent>
    </>
  );
}

/**
 * A chip is a path and a click. Both are stable — `openPreview` is a zustand
 * action, which zustand guarantees is the same function for the store's life —
 * so a settled chip never re-renders, however often the burst above it does.
 */
const FileChip = memo(FileChipImpl);
FileChip.displayName = 'FileChip';

/** `parts` is a fresh array per merge while a turn streams — see `same-parts.ts`. */
export const ActivityFileChipStep = memo(
  ActivityFileChipStepImpl,
  (a, b) =>
    a.sessionId === b.sessionId &&
    a.running === b.running &&
    a.bare === b.bare &&
    a.disableNavigation === b.disableNavigation &&
    samePartsList(a.parts, b.parts),
);
ActivityFileChipStep.displayName = 'ActivityFileChipStep';

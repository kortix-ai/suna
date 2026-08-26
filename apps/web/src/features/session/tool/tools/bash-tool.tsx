'use client';

import { HighlightedCode } from '@/components/markdown/code';
import { TextShimmer } from '@/components/ui/text-shimmer';
import {
  BasicTool,
  partInput,
  partMetadata,
  partOutput,
  partStatus,
  partStreamingInput,
  StructuredOutput,
  ToolRunningContext,
  useToolCardFrame,
  useToolCardPad,
  useToolIndent,
  useToolOpen,
} from '@/features/session/tool/shared/infrastructure';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import type { ToolProps } from '@/features/session/tool/shared/types';
import { cn } from '@/lib/utils';

import { CopyButton } from '@/components/markdown/copy-button';
import {
  formatBashOutput,
  InlineSessionMessagesList,
  parseSessionMessagesOutput,
  parseSessionMetadataOutput,
  SessionMetadataList,
} from '@/features/session/tool/shared/session-helpers';
import {
  hasStructuredContent,
  normalizeToolOutput,
  parseStructuredOutput,
} from '@/lib/utils/structured-output';
import { shellExitCode, stripAnsi } from '@/ui';
import { TerminalIcon } from '@phosphor-icons/react';
import { useContext, useMemo } from 'react';

/** The row title never runs past this; a trigger is one line, not a sentence. */
const TITLE_MAX = 60;

/**
 * The words a settled row leads with.
 *
 * The bash tool's input carries a `description` — the one-line summary the
 * model writes for its own call ("Install the workspace dependencies"). The
 * SDK already reads it as this tool's subtitle (`core/turns/parts.ts`, case
 * `'bash'`), so the row promotes a source it had been dropping rather than
 * inventing one. A reader scanning a turn wants to know what a command was
 * FOR, and `pnpm -w install --frozen-lockfile` answers that only if they read
 * shell.
 *
 * Three rules, in order:
 * - A failure keeps its verdict. "Command failed" is the one thing a friendly
 *   summary must never soften, so it outranks any description.
 * - No description → exactly today's "Ran command". Nothing is ever derived
 *   from the command text: a classifier answering "Installed dependencies" to
 *   `npm i` would put a claim in the model's mouth that it never made.
 * - Sentence case only lifts a lower-case opener. Lowering the rest would turn
 *   "Run CI on the release branch" into "Run ci on the release branch".
 */
export function bashRowTitle(description: unknown, failed: boolean): string {
  if (failed) return 'Command failed';

  // Collapsed, because a description arrives as free text and may carry a
  // newline; a trigger row renders it on one line either way.
  const summary = typeof description === 'string' ? description.replace(/\s+/g, ' ').trim() : '';
  if (!summary) return 'Ran command';

  const cased = /^[a-z]/.test(summary) ? summary[0].toUpperCase() + summary.slice(1) : summary;
  if (cased.length <= TITLE_MAX) return cased;
  // Trim the tail before the ellipsis. `truncate` in `lib/utils/string` cuts on
  // the character count alone, which strands a space in front of the ellipsis
  // whenever the cut lands just after a word.
  return `${cased.slice(0, TITLE_MAX).trimEnd()}…`;
}

/**
 * The command as the reader should see it: leading indent stripped, blank
 * edges dropped.
 *
 * Commands arrive with incidental leading whitespace — a model quoting a
 * command out of indented YAML/JSON sends `  agent-browser open …`. The
 * trigger row hides it (a `truncate` span collapses spaces under normal
 * white-space), but the card's `whitespace-pre-wrap` pane renders it verbatim,
 * so the first line sits two characters deeper than its own wrapped
 * continuation and the output below — an inverse hanging indent that reads as
 * broken padding.
 *
 * Two rules, because a one-line command and a script are different documents:
 *
 * - **One line has no structure to protect**, so every leading blank is noise
 *   and all of it goes. This is the case a common-indent rule cannot be
 *   trusted with alone: it only strips what it can MEASURE, and the measure
 *   used to be `[ \t]` — so a command indented with a non-breaking space (or
 *   any other Unicode space; agents paste these out of rendered docs and
 *   spreadsheets) kept its indent and drew exactly the misalignment above.
 * - **A script keeps its shape**: the COMMON indent goes, never a per-line
 *   trim, so nesting survives. Heredocs survive by construction — a non-`<<-`
 *   heredoc needs its terminator at column 0, which pins the common indent to
 *   0 and makes this a no-op exactly where indentation is load-bearing.
 *
 * `[^\S\r\n]` is "whitespace that is not a line break", so both rules count
 * every horizontal space character the Unicode table has, not just the two on
 * a US keyboard. The trailing trim also stops a final `\n` from counting as a
 * phantom `+1` line in the trigger.
 */
export function dedentCommand(raw: string): string {
  const text = raw.replace(/^[\r\n]+/, '').trimEnd();
  if (!text) return '';
  const lines = text.split('\n');
  // One line: strip the lot. `trimEnd` above already took the other end.
  if (lines.length === 1) return lines[0].replace(/^[^\S\r\n]+/, '');
  let min = Infinity;
  for (const line of lines) {
    if (!line.trim()) continue;
    min = Math.min(min, /^[^\S\r\n]*/.exec(line)![0].length);
  }
  if (!min || min === Infinity) return text;
  return lines.map((line) => line.slice(min)).join('\n');
}

/**
 * The command, syntax-highlighted, with its output beneath a hairline.
 *
 * Replaces a simulated `kortix@host:~$` prompt. The prompt dressed the command
 * up as a live shell it never was, spent the first third of every line on a
 * hostname the reader cannot act on, and — being plain text — gave a
 * multi-line pipeline no structure at all. Highlighting spends that space on
 * the command instead, so a `curl … | python3 -c "…"` reads as the two stages
 * it is.
 *
 * The command pane carries the same `bg-muted/40` wash the service-preview
 * header uses, so what was typed and what came back read as two zones without
 * a word of labelling — the tint says "invocation", the plain surface below
 * says "result". Inline only: on the panel the card has no frame to clip the
 * tint against, and a square tinted block floating inside the row body's
 * `px-3` gutter reads as a highlight, not a header.
 *
 * One frame, one type rhythm: `border bg-popover rounded-md` around content
 * panes that share a 12px inset and one `leading-relaxed` line height. That
 * pairing — `[&_code]:text-xs [&_code]:leading-relaxed` over a 12px pane — is
 * the same override `iam/audit-tab.tsx` uses to pull `HighlightedCode` down to
 * a small pane: the component hardcodes `text-sm leading-[1.65]` on its own
 * `<code>`, and a `[&_code]:` variant is one specificity step above it. The
 * size half was already here; without the leading half the highlighted command
 * kept a line height 0.3px off the output it sits above.
 *
 * That frame is the INLINE surface's. On the panel the frame and the
 * horizontal inset both belong to the row card this hangs inside
 * (`useToolCardFrame`), so only the vertical air around the command/output
 * hairline survives.
 *
 * The empty state takes that leading too, so a command that printed nothing
 * stands exactly where one line of output would instead of collapsing 3.5px
 * shorter than the region it speaks for (`text-xs` alone is a flat 16px line).
 * The exit-code strip keeps its shorter 8px vertical inset: it is metadata
 * about the card, not a third pane of content.
 */
function CommandBlock({
  command,
  output,
  richOutput,
  exitCode,
  settled,
}: {
  command: string;
  output: string;
  richOutput: React.ReactNode;
  exitCode?: number;
  /** The call has finished. Until it has, silence means "not yet", not "none". */
  settled: boolean;
}) {
  const hasOutput = Boolean(richOutput || output);
  const failed = typeof exitCode === 'number' && exitCode !== 0;
  // On the panel the row card is the frame and the disclosure body is the
  // inset, so this card draws neither — the gate counted FOUR seams around one
  // bash payload. The command/output hairline below is not one of them: it
  // separates two different things and stays on both surfaces.
  const frame = useToolCardFrame();
  const pad = useToolCardPad();
  // The one part of the card's inset the panel still needs. Horizontally the
  // row body's `px-3` is the gutter, but the hairline BETWEEN the command and
  // its output is internal to this card, and text pressed against it on both
  // sides is worse than the extra frame ever was.
  const paneInset = pad || 'py-2';

  return (
    // `overflow-hidden` clips the command pane's tint to the rounded frame;
    // without it the wash pokes square corners past `rounded-md`.
    <div className={cn('relative overflow-hidden', frame)}>
      {/* The tint rides the scroller, not a wrapper, so no `class="relative"`
          div lands between the card and `max-h-64` — the geometry tests locate
          the card by exactly that prefix. */}
      <div data-scrollable className={cn('max-h-64 overflow-auto', frame && 'bg-muted/40')}>
        <pre
          className={cn(
            'text-foreground/90 font-mono text-xs leading-relaxed wrap-break-word whitespace-pre-wrap [&_code]:border-none [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-xs [&_code]:leading-relaxed [&_code]:whitespace-pre-wrap [&_pre]:whitespace-pre-wrap [&_span]:border-none [&_span]:outline-none',
            paneInset,
            'pr-11',
          )}
        >
          <HighlightedCode code={command} language="bash">
            {command}
          </HighlightedCode>
        </pre>
      </div>
      {/* Anchored to the CARD, not to a wrapper inside the scroller — inside,
          it scrolled away with a long command while the output's stayed
          pinned. */}
      <div className="absolute top-2 right-2">
        <CopyButton code={command} className="text-muted-foreground/60 hover:text-foreground" />
      </div>

      {(hasOutput || settled) && (
        <div className="border-border/60 border-t">
          {richOutput ? (
            richOutput
          ) : output ? (
            <div className="relative">
              <div data-scrollable className="max-h-80 overflow-auto">
                <div
                  className={cn(
                    'text-muted-foreground font-mono text-xs leading-relaxed wrap-break-word whitespace-pre-wrap',
                    paneInset,
                    'pr-11',
                  )}
                >
                  {output}
                </div>
              </div>
              <div className="absolute top-2 right-2">
                <CopyButton
                  code={output}
                  className="text-muted-foreground/60 hover:text-foreground"
                />
              </div>
            </div>
          ) : (
            <p className={cn('text-muted-foreground/50', paneInset, 'text-xs leading-relaxed')}>
              No output
            </p>
          )}
        </div>
      )}

      {failed && (
        <div
          className={cn(
            // `kortix-red`, matching the trigger's "Command failed": the strip
            // is the card's own copy of the verdict, so the two agree in tone.
            'border-border/60 text-kortix-red border-t py-2 font-mono text-xs tabular-nums',
            // Metadata about the card, not a third pane: it keeps the shorter
            // 8px vertical inset, and only the horizontal one is the surface's
            // to supply.
            pad && 'px-3',
          )}
        >
          Exit code {exitCode}
        </div>
      )}
    </div>
  );
}

/**
 * The words on the trigger row.
 *
 * Its own component, not inline JSX in {@link BashTool}, because
 * `useToolOpen()` only answers truthfully where the trigger is RENDERED —
 * inside `BasicTool`'s provider. Called from `BashTool`'s body it would read
 * the context default and never change.
 *
 * Open, the row drops the command. The card directly beneath is already
 * showing that exact text — highlighted, whole, with its own copy button — so
 * the trigger's one line was spending itself on the only thing the reader
 * cannot be missing, in a truncated copy that disagreed with the full one for
 * every command longer than the row. What survives is the part the card does
 * not repeat: the description, or the failure verdict.
 *
 * Closed, that line is the only evidence of what ran, so it stays exactly as
 * it was — preview, `+N` line count, and the full command as the native
 * tooltip.
 */
function BashTrigger({
  title,
  failed,
  command,
  commandPreview,
  extraLines,
  live,
}: {
  title: string;
  failed: boolean;
  command: string;
  commandPreview: string;
  extraLines: number;
  /** The call is still running under a live stream. */
  live: boolean;
}) {
  const open = useToolOpen();

  if (live) {
    return (
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
        {open ? (
          // The shimmer moves to the label: mid-flight the row still has to
          // read as in-progress, and with the command gone there is nothing
          // else left on it to carry the motion.
          <TextShimmer duration={1} spread={2} className="min-w-0 truncate text-xs">
            Running command
          </TextShimmer>
        ) : (
          <>
            <span className="text-foreground shrink-0 text-xs">Running command</span>
            <TextShimmer
              duration={1}
              spread={2}
              className="text-muted-foreground min-w-0 truncate font-mono text-xs"
            >
              {commandPreview}
            </TextShimmer>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
      <span
        className="flex min-w-0 shrink-0 items-center gap-2 text-xs"
        // Redundant once the card spells the command out below.
        title={open ? undefined : command}
      >
        {/* `truncate`, not `shrink-0`: a description title is a sentence, and
            on a narrow row a rigid one would be clipped mid-word by the
            trigger's `overflow-hidden` instead of ending in an ellipsis. */}
        <span className={cn('min-w-0 truncate', failed ? 'text-kortix-red' : 'text-foreground')}>
          {title}
        </span>
        {!open && (
          <>
            <span className="text-muted-foreground/60 min-w-0 truncate font-mono">
              {commandPreview}
            </span>
            {extraLines > 0 && (
              <span className="text-muted-foreground/40 shrink-0 tabular-nums">+{extraLines}</span>
            )}
          </>
        )}
      </span>
    </div>
  );
}

export function BashTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const input = partInput(part);
  const streamingInput = partStreamingInput(part);
  const metadata = partMetadata(part);
  const output = partOutput(part);
  const status = partStatus(part);
  const running = useContext(ToolRunningContext);
  const indent = useToolIndent();
  const rawCommand =
    (input.command as string) ||
    (metadata.command as string) ||
    (streamingInput.command as string) ||
    '';
  // Everything downstream — card, preview, line count, copy — shows the
  // dedented text, so the row and the pane can never disagree about where the
  // command starts. No manual memo: a command is a short string, and wrapping
  // this in `useMemo` made the React Compiler skip the whole component
  // (`preserve-manual-memoization`) — a far worse trade than re-splitting a
  // one-line string.
  const command = dedentCommand(rawCommand);
  const strippedOutput = useMemo(() => (output ? stripAnsi(output) : ''), [output]);

  const sessionMeta = useMemo(() => parseSessionMetadataOutput(strippedOutput), [strippedOutput]);

  const sessionMessages = useMemo(
    () => (sessionMeta ? null : parseSessionMessagesOutput(strippedOutput)),
    [strippedOutput, sessionMeta],
  );

  const structuredSections = useMemo(() => {
    if (sessionMeta || sessionMessages || !strippedOutput) return null;
    const normalized = normalizeToolOutput(strippedOutput);
    if (!hasStructuredContent(normalized)) return null;
    return parseStructuredOutput(normalized);
  }, [strippedOutput, sessionMeta, sessionMessages]);

  const plainOutput = useMemo(() => {
    if (!strippedOutput || sessionMeta || sessionMessages || structuredSections) return '';
    return formatBashOutput(strippedOutput).content;
  }, [strippedOutput, sessionMeta, sessionMessages, structuredSections]);

  const richOutput = sessionMeta ? (
    <SessionMetadataList sessions={sessionMeta} />
  ) : sessionMessages ? (
    <InlineSessionMessagesList messages={sessionMessages} />
  ) : structuredSections ? (
    <StructuredOutput sections={structuredSections} />
  ) : null;

  const isStalePending = !command && !running && (status === 'pending' || status === 'running');

  const exitCode = useMemo(() => {
    if (part.state.status !== 'completed') return undefined;
    return shellExitCode(part.state.output ?? '');
  }, [part.state]);
  const failed = typeof exitCode === 'number' && exitCode !== 0;
  const title = bashRowTitle(input.description, failed);

  const { commandPreview, extraLines } = useMemo(() => {
    const lines = command.split('\n');
    return { commandPreview: lines[0] || '', extraLines: lines.length - 1 };
  }, [command]);

  return (
    <BasicTool
      icon={<TerminalIcon className="size-4 shrink-0" />}
      trigger={
        isStalePending ? (
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <TextShimmer duration={1} spread={2}>
              Working...
            </TextShimmer>
          </div>
        ) : commandPreview ? (
          <BashTrigger
            title={title}
            failed={failed}
            command={command}
            commandPreview={commandPreview}
            extraLines={extraLines}
            live={running && status !== 'completed' && status !== 'error'}
          />
        ) : null
      }
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {command && (
        // `CommandBlock` is a bordered card like the shared three, so it takes
        // the same gate: the seam belongs to the inline row it hangs under, not
        // to the panel body that already supplies `px-3 py-3`.
        <div className={cn(indent && 'mt-1.5', indent)}>
          <CommandBlock
            command={command}
            output={plainOutput}
            richOutput={richOutput}
            exitCode={exitCode}
            settled={status === 'completed' || status === 'error'}
          />
        </div>
      )}
    </BasicTool>
  );
}
ToolRegistry.register('bash', BashTool);

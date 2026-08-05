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
  useToolIndent,
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
import { stripAnsi } from '@/ui';
import { TerminalWindowIcon } from '@phosphor-icons/react';
import { useContext, useMemo } from 'react';

/**
 * The command, syntax-highlighted, with its output beneath a hairline.
 *
 * Replaces a simulated `kortix@host:~$` prompt. The prompt dressed the command
 * up as a live shell it never was, spent the first third of every line on a
 * hostname the reader cannot act on, and — being plain text — gave a
 * multi-line pipeline no structure at all. Highlighting spends that space on
 * the command instead, so a `curl … | python3 -c "…"` reads as the two stages
 * it is.
 */
function CommandBlock({
  command,
  output,
  richOutput,
}: {
  command: string;
  output: string;
  richOutput: React.ReactNode;
}) {
  const hasOutput = Boolean(richOutput || output);

  return (
    <div className="border-border bg-popover relative rounded-md border">
      <div data-scrollable className="max-h-96 overflow-auto">
        {/* The command and its copy button, not a flex row.

            As a row, the button was a layout participant: `items-center` hung
            it off the vertical middle of a three-line command, `mr-3` took 12px
            of width, and the `<pre>` STILL reserved `pr-9` for it — 76px of
            dead space for a 28px control. The `<pre>` also had no `min-w-0`, so
            an unbreakable path could set the row's minimum width and push the
            button out of the card. Floating the button over a plain block
            settles all four: nothing to centre, nothing to shrink. */}
        <div className="relative">
          {/* `[&_code]:text-xs` is load-bearing. `SHIKI_RESET` puts `text-sm` on
              the <code> it renders, and a class on the child beats a font size
              inherited from this <pre> — so the command drew at 14px against
              12px output, two type sizes in one card. (`text-inherit` is not
              the fix: in Tailwind that sets colour, not size.) Command and
              output now share 12px, and the hierarchy is carried by colour. */}
          <pre className="text-foreground/90 p-3 pr-11 font-mono text-xs leading-[1.65] wrap-break-word whitespace-pre-wrap [&_code]:border-none [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-xs [&_code]:whitespace-pre-wrap [&_pre]:whitespace-pre-wrap [&_span]:border-none [&_span]:outline-none">
            <HighlightedCode code={command} language="bash">
              {command}
            </HighlightedCode>
          </pre>
          {/* Optically centred on the first line, not on the block: the line's
              centre sits at 12px padding + (12px × 1.65) / 2 = 21.9px, and the
              28px button inset 8px centres at 22px.

              The wrapper carries the position, not the button — `hit-area-3`
              sets `position: relative` on the button itself, so an `absolute`
              passed through `className` would be two competing declarations
              settled by stylesheet order. This is `CopyOverlay`'s pattern. */}
          <div className="absolute top-2 right-2">
            <CopyButton code={command} className="text-muted-foreground/60 hover:text-foreground" />
          </div>
        </div>

        {hasOutput && (
          <div className="border-border/60 border-t">
            {/* `richOutput` is an already-rendered tree (a session list, a
                message list, a structured-output block) — NOT source text. It
                must never reach `HighlightedCode`: that prop is typed `string`
                and Shiki's cache key calls `.slice` on it, so passing an
                element threw `code.slice is not a function` during render and
                took the whole tool part down. Each component styles itself. */}
            {richOutput ? (
              richOutput
            ) : (
              <div className="text-muted-foreground p-3 font-mono text-xs leading-[1.65] wrap-break-word whitespace-pre-wrap">
                {output}
              </div>
            )}
          </div>
        )}
      </div>
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
  const command =
    (input.command as string) ||
    (metadata.command as string) ||
    (streamingInput.command as string) ||
    '';
  const strippedOutput = output ? stripAnsi(output) : '';

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

  const commandPreview = command.split('\n')[0] || '';

  return (
    <BasicTool
      icon={<TerminalWindowIcon className="size-4 shrink-0" />}
      trigger={
        isStalePending ? (
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <TextShimmer duration={1} spread={2}>
              Working...
            </TextShimmer>
          </div>
        ) : commandPreview ? (
          // The `$` that used to lead this row is gone: the terminal icon in
          // the gutter already says "shell", so the sigil spent horizontal
          // space repeating it and pushed the command — the only part worth
          // reading — further from the eye.
          <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
            {running && status !== 'completed' && status !== 'error' ? (
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
            ) : (
              <span className="min-w-0 truncate text-xs" title={command}>
                <span className="text-foreground">Ran command</span>{' '}
                <span className="text-muted-foreground font-mono">{commandPreview}</span>
              </span>
            )}
          </div>
        ) : null
      }
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {/* Shared with read / write / edit so all four code blocks line up: the
			    trigger's icon column is `size-4` and TOOL_ROW_CLASS sets `gap-1.5`,
			    which puts the text — and therefore this block — 22px in. The old
			    `ml-7` here was computed against a `gap-3` the row class never had,
			    and the indent was applied on every surface — including the panel,
			    which has no icon gutter to line up with. `useToolIndent` drops it
			    there. */}
      {command && (
        <div className={cn('mt-1.5', indent)}>
          <CommandBlock command={command} output={plainOutput} richOutput={richOutput} />
        </div>
      )}
    </BasicTool>
  );
}
ToolRegistry.register('bash', BashTool);

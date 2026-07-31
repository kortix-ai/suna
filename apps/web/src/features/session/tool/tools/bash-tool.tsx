'use client';

import { HighlightedCode } from '@/components/markdown/unified-markdown';
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
} from '@/features/session/tool/shared/infrastructure';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import type { ToolProps } from '@/features/session/tool/shared/types';

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
        <div className="flex w-full items-center justify-between">
          <pre className="text-foreground/90 px-0 py-2.5 pr-9 font-mono text-xs leading-[1.65] wrap-break-word whitespace-pre-wrap [&_code]:border-none [&_code]:bg-transparent [&_code]:p-0 [&_code]:whitespace-pre-wrap [&_pre]:whitespace-pre-wrap [&_span]:border-none [&_span]:outline-none">
            <HighlightedCode code={command} language="bash">
              {command}
            </HighlightedCode>
          </pre>
          <span className="mr-3">
            <CopyButton code={command} className="text-muted-foreground/60 hover:text-foreground" />
          </span>
        </div>

        {hasOutput && (
          <div className="border-border/60 border-t">
            {richOutput ? (
              <HighlightedCode language="bash" code={richOutput as unknown as string}>
                {richOutput}
              </HighlightedCode>
            ) : (
              <div className="text-muted-foreground px-3 py-2 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
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
            <span className="text-muted-foreground/60 shrink-0 font-mono text-xs select-none">
              $
            </span>
            <TextShimmer duration={1} spread={2} className="text-xs italic">
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
              <TextShimmer duration={1} spread={2} className="min-w-0 truncate font-mono text-xs">
                {commandPreview}
              </TextShimmer>
            ) : (
              <span
                className="text-muted-foreground min-w-0 truncate font-mono text-xs"
                title={command}
              >
                {commandPreview}
              </span>
            )}
          </div>
        ) : null
      }
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {/* 28px = the trigger's icon column (`size-4`) plus its `gap-3`, so the
			    block starts exactly where the command in the row above does. */}
      {command && (
        <div className="mt-1.5 ml-7">
          <CommandBlock command={command} output={plainOutput} richOutput={richOutput} />
        </div>
      )}
    </BasicTool>
  );
}
ToolRegistry.register('bash', BashTool);

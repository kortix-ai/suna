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
import { shellExitCode, stripAnsi } from '@/ui';
import { CodeSimpleIcon } from '@phosphor-icons/react';
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

  return (
    <div className="border-border bg-popover relative rounded-md border">
      <div data-scrollable className="max-h-64 overflow-auto">
        <div className="relative">
          <pre className="text-foreground/90 p-3 pr-11 font-mono text-xs leading-[1.65] wrap-break-word whitespace-pre-wrap [&_code]:border-none [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-xs [&_code]:whitespace-pre-wrap [&_pre]:whitespace-pre-wrap [&_span]:border-none [&_span]:outline-none">
            <HighlightedCode code={command} language="bash">
              {command}
            </HighlightedCode>
          </pre>
          <div className="absolute top-2 right-2">
            <CopyButton code={command} className="text-muted-foreground/60 hover:text-foreground" />
          </div>
        </div>
      </div>

      {(hasOutput || settled) && (
        <div className="border-border/60 border-t">
          {richOutput ? (
            richOutput
          ) : output ? (
            <div className="relative">
              <div data-scrollable className="max-h-80 overflow-auto">
                <div className="text-muted-foreground p-3 pr-11 font-mono text-xs leading-[1.65] wrap-break-word whitespace-pre-wrap">
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
            <p className="text-muted-foreground/50 p-3 text-xs">No output</p>
          )}
        </div>
      )}

      {failed && (
        <div className="border-border/60 text-muted-foreground/70 border-t px-3 py-2 font-mono text-xs tabular-nums">
          Exit code {exitCode}
        </div>
      )}
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

  const { commandPreview, extraLines } = useMemo(() => {
    const lines = command.split('\n');
    return { commandPreview: lines[0] || '', extraLines: lines.length - 1 };
  }, [command]);

  return (
    <BasicTool
      icon={<CodeSimpleIcon className="size-4 shrink-0" />}
      trigger={
        isStalePending ? (
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <TextShimmer duration={1} spread={2}>
              Working...
            </TextShimmer>
          </div>
        ) : commandPreview ? (
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
              <span className="flex min-w-0 items-center gap-2 text-xs" title={command}>
                <span className={cn('shrink-0', failed ? 'text-kortix-red' : 'text-foreground')}>
                  {failed ? 'Command failed' : 'Ran command'}
                </span>
                <span className="text-muted-foreground/60 min-w-0 truncate font-mono">
                  {commandPreview}
                </span>
                {extraLines > 0 && (
                  <span className="text-muted-foreground/40 shrink-0 tabular-nums">
                    +{extraLines}
                  </span>
                )}
              </span>
            )}
          </div>
        ) : null
      }
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {command && (
        <div className={cn('mt-1.5', indent)}>
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

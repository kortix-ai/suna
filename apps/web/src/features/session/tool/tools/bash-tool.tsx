'use client';

import { Separator } from '@/components/ui/separator';
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
import { Fragment, useContext, useMemo } from 'react';

function terminalHost(sessionId: string | undefined): string {
  if (!sessionId) return 'computer';
  const cleaned = sessionId.replace(/^ses[_-]/i, '');
  return cleaned.slice(0, 8).toLowerCase() || 'computer';
}

function TerminalPrompt({ host }: { host: string }) {
  return (
    <span className="select-none">
      <span className="text-kortix-green">kortix@{host}</span>
      <span className="text-muted-foreground/50">:</span>
      <span className="text-kortix-blue">~</span>
      <span className="text-muted-foreground/50">$ </span>
    </span>
  );
}

function TerminalCommand({
  command,
  host,
  showCaret,
}: {
  command: string;
  host: string;
  showCaret: boolean;
}) {
  const lines = command.split('\n');
  return (
    <div className="text-foreground leading-relaxed break-all whitespace-pre-wrap">
      {lines.map((line, i) => (
        <div key={i}>
          {i === 0 ? (
            <TerminalPrompt host={host} />
          ) : (
            <span className="text-muted-foreground/50 select-none">{'> '}</span>
          )}
          {line}
          {showCaret && i === lines.length - 1 && (
            <span className="bg-foreground/70 ml-0.5 inline-block h-3 w-1.5 translate-y-0.5 animate-pulse" />
          )}
        </div>
      ))}
    </div>
  );
}

function TerminalEntry({
  command,
  host,
  output,
  richOutput,
  running,
}: {
  command: string;
  host: string;
  output: string;
  richOutput: React.ReactNode;
  running: boolean;
}) {
  return (
    <div>
      <TerminalCommand
        command={command}
        host={host}
        showCaret={running && !output && !richOutput}
      />

      {richOutput ? (
        <div className="mt-1 font-sans">{richOutput}</div>
      ) : output ? (
        <div className="text-muted-foreground mt-0.5 leading-relaxed break-words whitespace-pre-wrap">
          {output}
        </div>
      ) : null}
    </div>
  );
}

export function BashTool({ part, sessionId, defaultOpen, forceOpen, locked }: ToolProps) {
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
  const description = (input.description as string) || (streamingInput.description as string) || '';
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

  const host = terminalHost(sessionId || part.sessionID);

  const entries = useMemo(() => [{ command, output: plainOutput }], [command, plainOutput]);

  const commandPreview = command.split('\n')[0] || '';

  return (
    <BasicTool
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
          <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
            <span className="text-muted-foreground/60 shrink-0 font-mono text-xs select-none">
              $
            </span>
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
      <div className="overflow-hidden pt-4">
        <div data-scrollable className="max-h-96 overflow-auto font-mono text-xs">
          {entries.map((entry, i) => (
            <Fragment key={i}>
              {i > 0 && <Separator className="my-3" />}
              <TerminalEntry
                command={entry.command}
                host={host}
                output={entry.output}
                richOutput={richOutput}
                running={running && status !== 'completed' && status !== 'error'}
              />
            </Fragment>
          ))}
        </div>
      </div>
    </BasicTool>
  );
}
ToolRegistry.register('bash', BashTool);

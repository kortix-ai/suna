'use client';
import { Badge } from '@/components/ui/badge';
import { InlineMeta } from '@/components/ui/inline-meta';
import { StatusDot } from '@/components/ui/status';
import {
  BasicTool,
  isErrorOutput,
  partInput,
  partOutput,
  partStatus,
  ToolOutputFallback,
} from '@/features/session/tool/shared/infrastructure';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import { ToolResultCard } from '@/features/session/tool/shared/result-card';
import type { ToolProps } from '@/features/session/tool/shared/types';
import { TerminalWindowIcon as Terminal } from '@phosphor-icons/react';
import { useMemo } from 'react';

export function PtySpawnTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const input = partInput(part);
  const output = partOutput(part);
  const status = partStatus(part);

  const parsed = useMemo(() => {
    const match = output.match(/<pty_spawned>([\s\S]*?)<\/pty_spawned>/);
    if (!match) return null;
    const fields: Record<string, string> = {};
    for (const line of match[1].trim().split('\n')) {
      const colonIdx = line.indexOf(':');
      if (colonIdx > 0) {
        fields[line.slice(0, colonIdx).trim()] = line.slice(colonIdx + 1).trim();
      }
    }
    return fields;
  }, [output]);

  const title = parsed?.Title || (input.title as string) || '';
  const command = parsed?.Command || (input.command as string) || '';
  const processStatus = parsed?.Status || '';
  const pid = parsed?.PID || '';
  const ptyId = parsed?.ID || '';
  const workdir = parsed?.Workdir || '';

  return (
    <BasicTool
      icon={<Terminal className="size-3.5 shrink-0" />}
      trigger={{
        title: 'Started terminal',
        subtitle: title || command,
        // Only when the subtitle IS the command. The card below prints the
        // command under a `$`, so open, the row would say it twice — and the
        // trigger's copy is the truncated one, so a long invocation disagrees
        // with the full text directly beneath it. When the model supplied a
        // `Title`, the subtitle is that name, the card never repeats it, and
        // it stays. Same rule as `bash`: the row keeps what the card does not
        // say.
        hideSubtitleWhenOpen: !title,
      }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {status === 'completed' && isErrorOutput(output) ? (
        <ToolOutputFallback output={output} toolName="pty_spawn" />
      ) : (
        // The spawned process is a result the tool returned, so it gets the
        // same hairlined card every other result lives in. Bare, it had no edge
        // and ran straight into the chain rail beside it.
        <ToolResultCard>
          <div className="space-y-2 px-2 py-1.5">
            {command && (
              <div className="font-mono text-xs leading-relaxed wrap-break-word whitespace-pre-wrap">
                <span className="text-muted-foreground/50 select-none">$</span>{' '}
                <span className="text-foreground/80">{command}</span>
              </div>
            )}
            {(processStatus || ptyId || pid || workdir) && (
              <InlineMeta>
                {processStatus && (
                  <Badge
                    variant={processStatus === 'running' ? 'success' : 'muted'}
                  >
                    {processStatus === 'running' && <StatusDot tone="success" pulse />}
                    {processStatus}
                  </Badge>
                )}
                {ptyId && <span className="font-mono">{ptyId}</span>}
                {pid && <span className="font-mono">PID {pid}</span>}
                {workdir && (
                  <span className="font-mono" title={workdir}>
                    {workdir}
                  </span>
                )}
              </InlineMeta>
            )}
          </div>
        </ToolResultCard>
      )}
    </BasicTool>
  );
}
ToolRegistry.register('pty_spawn', PtySpawnTool);

'use client';
import { Badge } from '@/components/ui/badge';
import { InlineMeta } from '@/components/ui/inline-meta';
import { StatusDot } from '@/components/ui/status';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import type { ToolProps } from '@/features/session/tool/shared/types';
import {
  BasicTool,
  isErrorOutput,
  ToolOutputFallback,
  partInput,
  partOutput,
  partStatus,
} from '@/features/session/tool/shared/infrastructure';
import {
  Terminal,
} from 'lucide-react';
import {
  useMemo,
} from 'react';


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
      icon={<Terminal className="size-3.5 flex-shrink-0" />}
      trigger={{ title: 'Spawn', subtitle: title || command }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {status === 'completed' && isErrorOutput(output) ? (
        <ToolOutputFallback output={output} toolName="pty_spawn" />
      ) : (
      <div className="space-y-2 px-3 py-2">
        {command && (
          <div className="font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
            <span className="text-muted-foreground/50 select-none">$</span>{' '}
            <span className="text-foreground/80">{command}</span>
          </div>
        )}
        {(processStatus || ptyId || pid || workdir) && (
          <InlineMeta>
            {processStatus && (
              <Badge
                variant={processStatus === 'running' ? 'success' : 'muted'}
                size="sm"
                className="gap-1"
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
      )}
    </BasicTool>
  );
}
ToolRegistry.register('pty_spawn', PtySpawnTool);


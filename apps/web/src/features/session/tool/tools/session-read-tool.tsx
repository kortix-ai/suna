'use client';
import { STATUS_TEXT, } from '@/components/ui/status';
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
import { OutputBlock } from '@/features/session/tool/shared/output-block';
import { cn } from '@/lib/utils';
import {
  Check,
  CircleAlert,
  Clock,
  Glasses,
} from 'lucide-react';
import {
  useMemo,
} from 'react';


export function SessionReadTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const input = partInput(part);
  const output = partOutput(part);
  const status = partStatus(part);
  const sessionId = (input.session_id as string) || '';
  const mode = (input.mode as string) || 'summary';
  const pattern = (input.pattern as string) || '';
  const sid = sessionId.length > 16 ? `…${sessionId.slice(-12)}` : sessionId;
  const modeLabel =
    mode === 'tools'
      ? 'tools'
      : mode === 'full'
        ? 'full'
        : mode === 'search'
          ? 'search'
          : 'summary';

  const parsed = useMemo(() => {
    if (!output) return null;
    const statusM = output.match(/\*\*Status:\*\*\s*(\w+)/);
    const agentM = output.match(/\*\*Agent:\*\*\s*(\w+)/);
    const msgsM = output.match(/\*\*Messages:\*\*\s*(\d+)/);
    const toolsM = output.match(/\*\*Tool calls:\*\*\s*(\d+)/);
    const toolListM = output.match(/\*\*Tools:\*\*\s*(.+)/);
    return {
      status: statusM?.[1] || null,
      agent: agentM?.[1] || null,
      messages: msgsM?.[1] || null,
      toolCalls: toolsM?.[1] || null,
      toolList: toolListM?.[1]?.split(', ').map((t) => t.trim()) || [],
    };
  }, [output]);

  const toolEntries = useMemo(() => {
    if (mode !== 'tools' || !output) return [];
    const entries: Array<{ status: string; tool: string; summary: string }> = [];
    const re = /^\[(\w+)\]\s+\*\*(\w+)\*\*:\s*(.+)/gm;
    let m;
    while ((m = re.exec(output)) !== null) {
      entries.push({ status: m[1], tool: m[2], summary: m[3].slice(0, 120) });
    }
    return entries;
  }, [mode, output]);

  const statusArgs: string[] = [];
  if (parsed?.status) statusArgs.push(parsed.status);
  if (parsed?.messages) statusArgs.push(`${parsed.messages} msgs`);
  if (parsed?.toolCalls && parsed.toolCalls !== '0') statusArgs.push(`${parsed.toolCalls} tools`);
  if (mode === 'search' && pattern) statusArgs.push(`/${pattern}/`);

  return (
    <BasicTool
      icon={<Glasses className="size-3.5 flex-shrink-0" />}
      trigger={{
        title: `Session · ${modeLabel}`,
        subtitle: sid,
        args: statusArgs,
      }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {mode === 'tools' && toolEntries.length > 0 ? (
        <div data-scrollable className="max-h-72 overflow-auto">
          {toolEntries.map((entry, i) => (
            <div
              key={i}
              className="border-border/10 flex items-start gap-0 border-b last:border-b-0"
            >
              <span className="w-6 flex-shrink-0 py-1 text-center font-mono text-xs select-none">
                {entry.status === 'completed' ? (
                  <Check className={cn('inline size-2.5', STATUS_TEXT.success)} />
                ) : entry.status === 'pending' ? (
                  <Clock className="text-muted-foreground/50 inline size-2.5" />
                ) : (
                  <CircleAlert className={cn('inline size-2.5', STATUS_TEXT.destructive)} />
                )}
              </span>
              <span className="text-foreground/80 w-24 flex-shrink-0 truncate py-1 font-mono text-xs font-medium">
                {entry.tool}
              </span>
              <span className="text-muted-foreground/60 truncate py-1 pr-2 font-mono text-xs">
                {entry.summary}
              </span>
            </div>
          ))}
        </div>
      ) : isErrorOutput(output) ? (
        <ToolOutputFallback output={output} toolName="session_read" />
      ) : output ? (
        <OutputBlock text={output} markdown />
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('session_read', SessionReadTool);
ToolRegistry.register('session-read', SessionReadTool);
ToolRegistry.register('oc-session_read', SessionReadTool);
ToolRegistry.register('oc-session-read', SessionReadTool);


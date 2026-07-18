'use client';
import { Badge } from '@/components/ui/badge';
import { STATUS_TEXT, } from '@/components/ui/status';
import { SubSessionModal } from '@/features/session/sub-session-modal';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import type { ToolProps } from '@/features/session/tool/shared/types';
import {
  BasicTool,
  isErrorOutput,
  ToolOutputFallback,
  partOutput,
  partStatus,
} from '@/features/session/tool/shared/infrastructure';
import { cn } from '@/lib/utils';
import {
  Check,
  ChevronRight,
  Circle,
  Clock,
  Layers,
  Loader2,
  X,
} from 'lucide-react';
import {
  useMemo,
  useState,
} from 'react';


import { OutputBlock } from '@/features/session/tool/shared/output-block';
import { cleanWorkerOutput, parseTaskRows } from '@/features/session/tool/shared/agent-helpers';

export function AgentStatusTool({ part, forceOpen }: ToolProps) {
  const status = partStatus(part);
  const output = partOutput(part);
  const isRunning = status === 'running' || status === 'pending';
  const [modalSessionId, setModalSessionId] = useState<string | null>(null);
  const [modalTitle, setModalTitle] = useState('');

  const taskRows = useMemo(() => parseTaskRows(output), [output]);
  const cleanedOutput = useMemo(() => cleanWorkerOutput(output), [output]);

  return (
    <>
      <BasicTool
        icon={<Layers className="size-3.5 flex-shrink-0" />}
        trigger={{ title: 'Agent status' }}
        badge={
          !isRunning && taskRows.length > 0 ? (
            <Badge variant="muted" size="sm">
              {taskRows.length} task{taskRows.length !== 1 ? 's' : ''}
            </Badge>
          ) : undefined
        }
        forceOpen={forceOpen}
      >
        {!isRunning && taskRows.length > 0 && (
          <div>
            {taskRows.map((row, i) => {
              const hasSession = !!row.sessionId;
              const isActive = row.status === 'in_progress';
              return (
                <div
                  key={row.id}
                  role={hasSession ? 'button' : undefined}
                  tabIndex={hasSession ? 0 : undefined}
                  onClick={() => {
                    if (hasSession) {
                      setModalSessionId(row.sessionId!);
                      setModalTitle(row.title);
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && hasSession) {
                      setModalSessionId(row.sessionId!);
                      setModalTitle(row.title);
                    }
                  }}
                  className={cn(
                    'border-border/20 flex items-center gap-2.5 px-3 py-2',
                    i > 0 && 'border-t',
                    hasSession && 'hover:bg-accent/50 cursor-pointer transition-colors',
                  )}
                >
                  {isActive ? (
                    <Loader2 className="text-muted-foreground size-3 flex-shrink-0 animate-spin" />
                  ) : row.status === 'completed' ? (
                    <Check className={cn('size-3 flex-shrink-0', STATUS_TEXT.success)} />
                  ) : row.status === 'input_needed' ? (
                    <Clock className={cn('size-3 flex-shrink-0', STATUS_TEXT.warning)} />
                  ) : row.status === 'cancelled' ? (
                    <X className="text-muted-foreground/40 size-3 flex-shrink-0" />
                  ) : (
                    <Circle className="text-muted-foreground/40 size-3 flex-shrink-0" />
                  )}

                  <span className="text-foreground/80 flex-1 truncate text-xs">{row.title}</span>

                  <span className="text-muted-foreground/50 flex-shrink-0 font-mono text-xs">
                    {row.id.slice(-8)}
                  </span>

                  {hasSession && (
                    <ChevronRight className="text-muted-foreground/20 size-3 flex-shrink-0" />
                  )}
                </div>
              );
            })}
          </div>
        )}

        {!isRunning && isErrorOutput(output) && (
          <ToolOutputFallback output={output} toolName="agent_status" />
        )}

        {!isRunning && !isErrorOutput(output) && taskRows.length === 0 && cleanedOutput && (
          <OutputBlock text={cleanedOutput} />
        )}
      </BasicTool>

      {modalSessionId && (
        <SubSessionModal
          open={!!modalSessionId}
          onOpenChange={(open) => {
            if (!open) setModalSessionId(null);
          }}
          sessionId={modalSessionId}
          title={modalTitle}
        />
      )}
    </>
  );
}
ToolRegistry.register('agent_status', AgentStatusTool);
ToolRegistry.register('agent-status', AgentStatusTool);
ToolRegistry.register('agent_task_list', AgentStatusTool);
ToolRegistry.register('agent-task-list', AgentStatusTool);


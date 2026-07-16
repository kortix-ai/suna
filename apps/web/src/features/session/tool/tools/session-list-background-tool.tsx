'use client';

import { StatusDot } from '@/components/ui/status';
import {
  BasicTool,
  isErrorOutput,
  partInput,
  partOutput,
  partStatus,
  ToolEmptyState,
  ToolOutputFallback,
} from '@/features/session/tool/shared/infrastructure';
import { OutputBlock } from '@/features/session/tool/shared/output-block';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import type { ToolProps } from '@/features/session/tool/shared/types';
import { Layers } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useMemo } from 'react';

export function SessionListBackgroundTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const input = partInput(part);
  const output = partOutput(part);
  const status = partStatus(part);
  const project = (input.project as string) || '';

  const workers = useMemo(() => {
    if (!output) return [];
    const entries: Array<{
      id: string;
      status: string;
      project: string;
      prompt: string;
    }> = [];
    const re = /\*\*(ses_\S+)\*\*.*?status:\s*(\w+).*?project:\s*(\S+)/gi;
    let m;
    while ((m = re.exec(output)) !== null) {
      entries.push({ id: m[1], status: m[2], project: m[3], prompt: '' });
    }
    return entries;
  }, [output]);

  const noWorkers = status === 'completed' && workers.length === 0 && !output.includes('ses_');

  return (
    <BasicTool
      icon={<Layers className="size-3.5 flex-shrink-0" />}
      trigger={{
        title: 'Background Sessions',
        subtitle: project || 'all projects',
        args: workers.length > 0 ? [`${workers.length} workers`] : noWorkers ? ['none'] : [],
      }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {workers.length > 0 ? (
        <div data-scrollable className="divide-border/20 max-h-56 divide-y overflow-auto">
          {workers.map((w) => (
            <div key={w.id} className="flex items-center gap-2 px-3 py-1.5">
              <StatusDot
                tone={
                  w.status === 'running' ? 'info' : w.status === 'complete' ? 'success' : 'neutral'
                }
                className="flex-shrink-0"
              />
              <span className="text-foreground/70 truncate font-mono text-xs">
                {w.id.slice(-12)}
              </span>
              <span className="text-muted-foreground/50 flex-1 truncate text-xs">{w.project}</span>
              <span className="text-muted-foreground/40 text-xs">{w.status}</span>
            </div>
          ))}
        </div>
      ) : isErrorOutput(output) ? (
        <ToolOutputFallback output={output} toolName="session_list" />
      ) : output ? (
        <OutputBlock text={output} markdown />
      ) : noWorkers ? (
        <ToolEmptyState
          message={tHardcodedUi.raw(
            'componentsSessionToolRenderers.line6183JsxAttrMessageNoBackgroundSessions',
          )}
        />
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('session_list', SessionListBackgroundTool);
ToolRegistry.register('session-list', SessionListBackgroundTool);
ToolRegistry.register('oc-session_list', SessionListBackgroundTool);
ToolRegistry.register('oc-session-list', SessionListBackgroundTool);
ToolRegistry.register('session_list_background', SessionListBackgroundTool);
ToolRegistry.register('session-list-background', SessionListBackgroundTool);
ToolRegistry.register('oc-session_list_background', SessionListBackgroundTool);
ToolRegistry.register('oc-session-list-background', SessionListBackgroundTool);
ToolRegistry.register('session_list_spawned', SessionListBackgroundTool);
ToolRegistry.register('session-list-spawned', SessionListBackgroundTool);
ToolRegistry.register('oc-session_list_spawned', SessionListBackgroundTool);
ToolRegistry.register('oc-session-list-spawned', SessionListBackgroundTool);

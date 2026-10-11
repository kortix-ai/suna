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
import { StackIcon as Layers } from '@phosphor-icons/react';
import { useTranslations } from '@/i18n/use-translations';
import { parseBackgroundWorkers } from '@kortix/shared/tool-output';
import { useMemo } from 'react';

export function SessionListBackgroundTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const input = partInput(part);
  const output = partOutput(part);
  const status = partStatus(part);
  const project = (input.project as string) || '';

  const workers = useMemo(() => parseBackgroundWorkers(output), [output]);

  // Both scan the full output — `includes` walks it, `isErrorOutput` trims a
  // copy of it and runs `JSON.parse`. Neither depends on render state.
  const mentionsSession = useMemo(() => output.includes('ses_'), [output]);
  const outputIsError = useMemo(() => isErrorOutput(output), [output]);

  const noWorkers = status === 'completed' && workers.length === 0 && !mentionsSession;

  return (
    <BasicTool
      icon={<Layers className="size-3.5 shrink-0" />}
      trigger={{
        title: tHardcodedUi.raw('i18nComplete.textdb08291c7ba0'),
        subtitle: project || tHardcodedUi.raw('i18nComplete.text1ff8ad6301d4'),
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
                className="shrink-0"
              />
              <span className="text-foreground/70 truncate font-mono text-xs">
                {w.id.slice(-12)}
              </span>
              <span className="text-muted-foreground/50 flex-1 truncate text-xs">{w.project}</span>
              <span className="text-muted-foreground/40 text-xs">{w.status}</span>
            </div>
          ))}
        </div>
      ) : outputIsError ? (
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
ToolRegistry.register('session-list', SessionListBackgroundTool);
ToolRegistry.register('session-list-background', SessionListBackgroundTool);
ToolRegistry.register('session-list-spawned', SessionListBackgroundTool);

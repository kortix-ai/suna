'use client';

import Loading from '@/components/ui/loading';
import {
  BasicTool,
  partInput,
  partOutput,
  ToolOutputFallback,
  ToolRunningContext,
} from '@/features/session/tool/shared/infrastructure';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import type { ToolProps } from '@/features/session/tool/shared/types';
import { ScissorsIcon as Scissors } from '@phosphor-icons/react';
import { useTranslations } from '@/i18n/use-translations';
import { useContext } from 'react';

export function DCPPruneTool({ part, defaultOpen, forceOpen }: ToolProps) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const input = partInput(part);
  const output = partOutput(part);
  const isRunning = useContext(ToolRunningContext);
  const ids = input.ids as string[] | undefined;
  const reason = input.reason as string | undefined;

  return (
    <BasicTool
      icon={<Scissors className="text-muted-foreground/50 size-3.5 shrink-0" />}
      trigger={
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="text-foreground text-xs font-medium whitespace-nowrap">
            {tI18nComplete.raw('text79403a38ef25')}
          </span>
          <span className="text-muted-foreground/50 text-xs font-medium whitespace-nowrap">
            DCP
          </span>
          {reason && <span className="text-muted-foreground/70 truncate text-xs">{reason}</span>}
          {ids && ids.length > 0 && (
            <span className="text-muted-foreground/60 ml-auto text-xs">
              {ids.length} {tI18nComplete.raw('textf9d35d43770d')}
            </span>
          )}
          {isRunning && <Loading className="text-muted-foreground ml-auto size-3" />}
        </div>
      }
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
    >
      {output ? <ToolOutputFallback output={output} toolName="prune" /> : null}
    </BasicTool>
  );
}
ToolRegistry.register('prune', DCPPruneTool);

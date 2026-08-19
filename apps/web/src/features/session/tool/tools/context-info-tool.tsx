'use client';
import {
  BasicTool,
  partOutput,
  ToolOutputFallback,
} from '@/features/session/tool/shared/infrastructure';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import type { ToolProps } from '@/features/session/tool/shared/types';
import { ScissorsIcon as Scissors } from '@phosphor-icons/react';
import { useTranslations } from 'next-intl';

export function ContextInfoTool({ part, defaultOpen, forceOpen }: ToolProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');

  const output = partOutput(part);
  if (!output) return null;

  return (
    <BasicTool
      icon={<Scissors className="text-muted-foreground/50 size-3.5 shrink-0" />}
      trigger={
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="text-muted-foreground/70 text-xs font-medium whitespace-nowrap">
            {tHardcodedUi.raw('componentsSessionToolRenderers.line5235JsxTextContextInfo')}
          </span>
          <span className="text-muted-foreground/50 text-xs font-medium whitespace-nowrap">
            DCP
          </span>
        </div>
      }
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
    >
      <ToolOutputFallback output={output} toolName="context_info" />
    </BasicTool>
  );
}
ToolRegistry.register('context_info', ContextInfoTool);

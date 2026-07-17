'use client';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import type { ToolProps } from '@/features/session/tool/shared/types';
import {
  BasicTool,
  isErrorOutput,
  ToolOutputFallback,
  partOutput,
} from '@/features/session/tool/shared/infrastructure';
import { OutputBlock } from '@/features/session/tool/shared/output-block';
import {
  Scissors,
} from 'lucide-react';
import { useTranslations } from 'next-intl';


export function ContextInfoTool({ part }: ToolProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');

  const output = partOutput(part);
  if (!output) return null;

  return (
    <BasicTool
      icon={<Scissors className="text-muted-foreground/50 size-3.5 flex-shrink-0" />}
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
    >
      {isErrorOutput(output) ? (
        <ToolOutputFallback output={output} toolName="context_info" />
      ) : (
        <div className="p-2">
          <OutputBlock text={output} className="scrollbar-hide max-h-32" />
        </div>
      )}
    </BasicTool>
  );
}
ToolRegistry.register('context_info', ContextInfoTool);


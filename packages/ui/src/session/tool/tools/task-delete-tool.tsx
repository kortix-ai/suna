'use client';
import {
  BasicTool,
  isErrorOutput,
  partOutput,
  partStatus,
  ToolOutputFallback,
} from '../shared/infrastructure';
import { ToolRegistry } from '../shared/registry';
import type { ToolProps } from '../shared/types';
import { TrashIcon as Trash2 } from '@phosphor-icons/react';
import { useTranslations } from '../../../i18n';
import { useMemo } from 'react';

export function TaskDeleteTool({ call, defaultOpen, forceOpen }: ToolProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const output = partOutput(call);
  const status = partStatus(call);
  // `isErrorOutput` trims a copy of the whole output and runs `JSON.parse` over
  // it; this sits in the body, so it ran on every render of the row.
  const outputIsError = useMemo(() => isErrorOutput(output), [output]);
  const isError = status === 'completed' && outputIsError;

  return (
    <BasicTool
      icon={<Trash2 className="size-3.5 shrink-0" />}
      trigger={{
        title: tHardcodedUi.raw('i18nComplete.text3baf55478483'),
        subtitle: isError ? 'failed' : undefined,
      }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
    >
      {isError ? (
        <ToolOutputFallback output={output} toolName="task_delete" />
      ) : (
        <div className="text-muted-foreground px-3 py-2 text-xs leading-relaxed">
          {tHardcodedUi.raw('componentsSessionToolRenderers.line6903JsxTextTaskRemoved')}
        </div>
      )}
    </BasicTool>
  );
}
ToolRegistry.register('task-delete', TaskDeleteTool);

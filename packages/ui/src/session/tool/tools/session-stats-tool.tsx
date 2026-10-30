'use client';

import {
  BasicTool,
  isErrorOutput,
  partOutput,
  ToolOutputFallback,
} from '../shared/infrastructure';
import { OutputBlock } from '../shared/output-block';
import { ToolRegistry } from '../shared/registry';
import type { ToolProps } from '../shared/types';
import { StackIcon as Layers } from '@phosphor-icons/react';
import { useTranslations } from '../../../i18n';
import { useMemo } from 'react';

export function SessionStatsTool({ call, defaultOpen, forceOpen }: ToolProps) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const output = partOutput(call);

  // `isErrorOutput` trims a copy of the whole output and runs `JSON.parse` over
  // it — asked once per render, whether the row is open or collapsed.
  const outputIsError = useMemo(() => isErrorOutput(output), [output]);

  return (
    <BasicTool
      icon={<Layers className="size-3.5 shrink-0" />}
      trigger={{ title: t.raw('textfe4aca69783d'), subtitle: '', args: [] }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
    >
      {outputIsError ? (
        <ToolOutputFallback output={output} toolName="session_stats" />
      ) : output ? (
        <OutputBlock text={output} markdown />
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('session-stats', SessionStatsTool);

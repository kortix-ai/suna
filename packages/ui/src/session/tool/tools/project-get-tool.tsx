'use client';

import { TextShimmer } from '../../../components/ui/text-shimmer';
import {
  BasicTool,
  isErrorOutput,
  partInput,
  partOutput,
  ToolOutputFallback,
} from '../shared/infrastructure';
import { OutputBlock } from '../shared/output-block';
import { ToolRegistry } from '../shared/registry';
import type { ToolProps } from '../shared/types';
import { FolderIcon as Folder } from '@phosphor-icons/react';
import { useTranslations } from '../../../i18n';
import { useMemo } from 'react';

export function ProjectGetTool({ call, defaultOpen, forceOpen }: ToolProps) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const input = partInput(call);
  const output = partOutput(call);
  const name = (input.name as string) || '';
  // `isErrorOutput` trims the whole output and runs `JSON.parse` over it; this
  // row re-ran that on every render, open or collapsed.
  const errored = useMemo(() => isErrorOutput(output), [output]);

  return (
    <BasicTool
      icon={<Folder className="text-muted-foreground size-3.5" />}
      trigger={{
        title: tI18nComplete.raw('textfb0b45908d60'),
        subtitle: name || 'Fetching...',
      }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
    >
      <div className="p-2">
        {errored ? (
          <ToolOutputFallback output={output} toolName="project_get" />
        ) : output ? (
          <OutputBlock text={output} />
        ) : (
          <div className="p-3">
            <TextShimmer>{tI18nComplete.raw('text47d2a515ef2f')}</TextShimmer>
          </div>
        )}
      </div>
    </BasicTool>
  );
}
ToolRegistry.register('project-get', ProjectGetTool);
ToolRegistry.register('project-update', ProjectGetTool);

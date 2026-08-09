'use client';
import { TextShimmer } from '@/components/ui/text-shimmer';
import {
  BasicTool,
  isErrorOutput,
  partInput,
  partOutput,
  ToolOutputFallback,
} from '@/features/session/tool/shared/infrastructure';
import { OutputBlock } from '@/features/session/tool/shared/output-block';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import type { ToolProps } from '@/features/session/tool/shared/types';
import { FolderIcon as Folder } from '@phosphor-icons/react';
import { useMemo } from 'react';

export function ProjectGetTool({ part, defaultOpen, forceOpen }: ToolProps) {
  const input = partInput(part);
  const output = partOutput(part);
  const name = (input.name as string) || '';
  // `isErrorOutput` trims the whole output and runs `JSON.parse` over it; this
  // row re-ran that on every render, open or collapsed.
  const errored = useMemo(() => isErrorOutput(output), [output]);

  return (
    <BasicTool
      icon={<Folder className="text-muted-foreground size-3.5" />}
      trigger={{
        title: 'Workspace Details',
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
            <TextShimmer>Loading...</TextShimmer>
          </div>
        )}
      </div>
    </BasicTool>
  );
}
ToolRegistry.register('project_get', ProjectGetTool);
ToolRegistry.register('project-get', ProjectGetTool);
ToolRegistry.register('oc-project_get', ProjectGetTool);
ToolRegistry.register('oc-project-get', ProjectGetTool);
ToolRegistry.register('project_update', ProjectGetTool);
ToolRegistry.register('project-update', ProjectGetTool);
ToolRegistry.register('oc-project_update', ProjectGetTool);
ToolRegistry.register('oc-project-update', ProjectGetTool);

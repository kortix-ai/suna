'use client';
import {
  BasicTool,
  isErrorOutput,
  partInput,
  partOutput,
  ToolOutputFallback,
  useToolNavigation,
} from '@/features/session/tool/shared/infrastructure';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import type { ToolProps } from '@/features/session/tool/shared/types';
import { CaretRightIcon as ChevronRight, FolderIcon as Folder } from '@phosphor-icons/react';
import { useMemo } from 'react';

import { parseProjectSelectOutput } from '@/lib/utils/kortix-tool-output';

export function WorkspaceSelectTool({ part }: ToolProps) {
  const input = partInput(part);
  const output = partOutput(part);
  const { enabled: navigationEnabled, openTab } = useToolNavigation();
  const project = (input.workspace as string) || '';
  const data = useMemo(() => parseProjectSelectOutput(output || ''), [output]);
  const name = data?.name || project;

  if (isErrorOutput(output)) {
    return (
      <BasicTool icon={<Folder />} trigger={{ title: 'Workspace', subtitle: name || 'failed' }}>
        <ToolOutputFallback output={output} toolName="project_select" />
      </BasicTool>
    );
  }

  return (
    <BasicTool
      icon={<Folder />}
      trigger={{
        title: 'Workspace Active',
        subtitle: name,
      }}
      onClick={
        navigationEnabled
          ? () =>
              openTab({
                id: 'page:/workspace',
                title: name,
                type: 'page' as any,
                href: '/workspace',
              })
          : undefined
      }
      rightAccessory={navigationEnabled ? <ChevronRight /> : undefined}
    />
  );
}
ToolRegistry.register('project_select', WorkspaceSelectTool);
ToolRegistry.register('project-select', WorkspaceSelectTool);
ToolRegistry.register('oc-project_select', WorkspaceSelectTool);
ToolRegistry.register('oc-project-select', WorkspaceSelectTool);

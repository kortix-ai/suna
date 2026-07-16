'use client';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import type { ToolProps } from '@/features/session/tool/shared/types';
import {
  BasicTool,
  isErrorOutput,
  ToolOutputFallback,
  partInput,
  partOutput,
  useToolNavigation,
} from '@/features/session/tool/shared/infrastructure';
import {
  ChevronRight,
  Folder,
} from 'lucide-react';
import {
  useMemo,
} from 'react';


import { parseProjectSelectOutput } from '@/lib/utils/kortix-tool-output';

export function ProjectSelectTool({ part }: ToolProps) {
  const input = partInput(part);
  const output = partOutput(part);
  const { enabled: navigationEnabled, openTab } = useToolNavigation();
  const project = (input.project as string) || '';
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
ToolRegistry.register('project_select', ProjectSelectTool);
ToolRegistry.register('project-select', ProjectSelectTool);
ToolRegistry.register('oc-project_select', ProjectSelectTool);
ToolRegistry.register('oc-project-select', ProjectSelectTool);


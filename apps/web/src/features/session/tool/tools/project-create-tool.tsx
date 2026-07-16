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
  Plus,
} from 'lucide-react';
import {
  useMemo,
} from 'react';


import { parseProjectCreateOutput } from '@/lib/utils/kortix-tool-output';

export function ProjectCreateTool({ part }: ToolProps) {
  const input = partInput(part);
  const output = partOutput(part);
  const { enabled: navigationEnabled, openTab } = useToolNavigation();
  const name = (input.name as string) || '';
  const data = useMemo(() => parseProjectCreateOutput(output || ''), [output]);
  const displayName = data?.name || name;

  if (isErrorOutput(output)) {
    return (
      <BasicTool icon={<Plus />} trigger={{ title: 'Workspace', subtitle: displayName || 'failed' }}>
        <ToolOutputFallback output={output} toolName="project_create" />
      </BasicTool>
    );
  }

  return (
    <BasicTool
      icon={<Plus />}
      trigger={{
        title: 'Workspace',
        subtitle: displayName,
      }}
      onClick={
        navigationEnabled
          ? () =>
              openTab({
                id: 'page:/workspace',
                title: displayName,
                type: 'page' as any,
                href: '/workspace',
              })
          : undefined
      }
      rightAccessory={navigationEnabled ? <ChevronRight /> : undefined}
    />
  );
}
ToolRegistry.register('project_create', ProjectCreateTool);
ToolRegistry.register('project-create', ProjectCreateTool);
ToolRegistry.register('oc-project_create', ProjectCreateTool);
ToolRegistry.register('oc-project-create', ProjectCreateTool);


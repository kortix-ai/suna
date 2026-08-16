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
import { CaretRightIcon as ChevronRight, PlusIcon as Plus } from '@phosphor-icons/react';
import { useCallback, useMemo } from 'react';

import { parseProjectCreateOutput } from '@/lib/utils/kortix-tool-output';

export function ProjectCreateTool({ part }: ToolProps) {
  const input = partInput(part);
  const output = partOutput(part);
  const { enabled: navigationEnabled, openTab } = useToolNavigation();
  const name = (input.name as string) || '';
  const data = useMemo(() => parseProjectCreateOutput(output || ''), [output]);
  const displayName = data?.name || name;
  // `isErrorOutput` trims the whole output and runs `JSON.parse` over it; it ran
  // on every render of a row whose output stopped changing when the call ended.
  const errored = useMemo(() => isErrorOutput(output), [output]);

  const handleOpenWorkspace = useCallback(() => {
    openTab({
      id: 'page:/workspace',
      title: displayName,
      type: 'page' as any,
      href: '/workspace',
    });
  }, [openTab, displayName]);

  if (errored) {
    return (
      <BasicTool
        icon={<Plus />}
        trigger={{ title: 'Workspace', subtitle: displayName || 'failed' }}
      >
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
      onClick={navigationEnabled ? handleOpenWorkspace : undefined}
      rightAccessory={navigationEnabled ? <ChevronRight /> : undefined}
    />
  );
}
ToolRegistry.register('project_create', ProjectCreateTool);
ToolRegistry.register('project-create', ProjectCreateTool);
ToolRegistry.register('oc-project_create', ProjectCreateTool);
ToolRegistry.register('oc-project-create', ProjectCreateTool);

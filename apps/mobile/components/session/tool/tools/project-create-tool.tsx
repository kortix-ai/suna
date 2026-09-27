/**
 * `project_create` — port of apps/web `tool/tools/project-create-tool.tsx`.
 *
 * Web taps the row to open the workspace tab; mobile opens the created
 * project's page (see `useOpenProjectHandler`).
 */

import { useMemo } from 'react';
import { PlusIcon } from '@/lib/icons';
import { disclosureKey } from '@/lib/session/disclosure-store';
import { projectCreateTrigger } from '@/lib/session/tools/projects-projects';
import { BasicTool, isErrorOutput, partInput, partOutput, ToolOutputFallback } from '../shared/infrastructure';
import { ToolRegistry } from '../shared/registry';
import type { ToolProps } from '../shared/types';
import { useOpenProjectHandler } from './project-select-tool';

export function ProjectCreateTool({ part, defaultOpen, forceOpen }: ToolProps) {
  const input = partInput(part);
  const output = partOutput(part);
  // `isErrorOutput` trims the whole output and runs `JSON.parse` over it.
  const errored = useMemo(() => isErrorOutput(output), [output]);
  const trigger = useMemo(() => projectCreateTrigger(input, output, errored), [input, output, errored]);
  const openProject = useOpenProjectHandler(part);

  if (errored) {
    return (
      <BasicTool
        disclosureId={disclosureKey('tool', part.id)}
        icon={PlusIcon}
        trigger={trigger}
        defaultOpen={defaultOpen}
        forceOpen={forceOpen}
      >
        <ToolOutputFallback output={output} toolName="project_create" />
      </BasicTool>
    );
  }

  return (
    <BasicTool
      disclosureId={disclosureKey('tool', part.id)}
      icon={PlusIcon}
      trigger={trigger}
      onClick={openProject}
    />
  );
}
ToolRegistry.register('project_create', ProjectCreateTool);
ToolRegistry.register('project-create', ProjectCreateTool);
ToolRegistry.register('oc-project_create', ProjectCreateTool);
ToolRegistry.register('oc-project-create', ProjectCreateTool);

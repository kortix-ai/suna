/**
 * `project_select` — port of apps/web `tool/tools/project-select-tool.tsx`.
 *
 * Web taps the row to open the workspace tab. Mobile has no workspace tab: a
 * completed row opens the selected project's page (`page:project:<id>`), the
 * behaviour mobile's row had before this port. A row with no project id is a
 * plain, untappable row.
 */

import { useCallback, useMemo } from 'react';
import { FolderIcon } from '@/lib/icons';
import { disclosureKey } from '@/lib/session/disclosure-store';
import { projectOpenTarget, projectSelectTrigger } from '@/lib/session/tools/projects-projects';
import { useTabStore } from '@/stores/tab-store';
import {
  BasicTool,
  isErrorOutput,
  partInput,
  partOutput,
  partStatus,
  ToolOutputFallback,
  useToolNavigation,
} from '../shared/infrastructure';
import { ToolRegistry } from '../shared/registry';
import type { ToolProps } from '../shared/types';

/** The tap handler for a completed project_select / project_create row, or `undefined`. */
export function useOpenProjectHandler(call: ToolProps['call']): (() => void) | undefined {
  const { enabled } = useToolNavigation();
  const input = partInput(call);
  const output = partOutput(call);
  const status = partStatus(call);
  const target = useMemo(
    () => projectOpenTarget(call.name, status, input, output),
    [call.name, status, input, output],
  );
  const open = useCallback(() => {
    if (!target) return;
    useTabStore.getState().navigateToPage(`page:project:${target.projectId}`);
  }, [target]);
  return enabled && target ? open : undefined;
}

export function ProjectSelectTool({ call, defaultOpen, forceOpen }: ToolProps) {
  const input = partInput(call);
  const output = partOutput(call);
  // `isErrorOutput` trims the whole output and runs `JSON.parse` over it.
  const errored = useMemo(() => isErrorOutput(output), [output]);
  const trigger = useMemo(() => projectSelectTrigger(input, output, errored), [input, output, errored]);
  const openProject = useOpenProjectHandler(call);

  if (errored) {
    return (
      <BasicTool
        disclosureId={disclosureKey('tool', call.id)}
        icon={FolderIcon}
        trigger={trigger}
        defaultOpen={defaultOpen}
        forceOpen={forceOpen}
      >
        <ToolOutputFallback output={output} toolName="project_select" />
      </BasicTool>
    );
  }

  return (
    <BasicTool
      disclosureId={disclosureKey('tool', call.id)}
      icon={FolderIcon}
      trigger={trigger}
      onClick={openProject}
    />
  );
}
ToolRegistry.register('project-select', ProjectSelectTool);

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
export function useOpenProjectHandler(part: ToolProps['part']): (() => void) | undefined {
  const { enabled } = useToolNavigation();
  const input = partInput(part);
  const output = partOutput(part);
  const status = partStatus(part);
  const target = useMemo(
    () => projectOpenTarget(part.tool, status, input, output),
    [part.tool, status, input, output],
  );
  const open = useCallback(() => {
    if (!target) return;
    const tabs = useTabStore.getState();
    const pageId = `page:project:${target.projectId}`;
    tabs.setTabState(pageId, { projectName: target.displayName });
    tabs.navigateToPage(pageId);
  }, [target]);
  return enabled && target ? open : undefined;
}

export function ProjectSelectTool({ part, defaultOpen, forceOpen }: ToolProps) {
  const input = partInput(part);
  const output = partOutput(part);
  // `isErrorOutput` trims the whole output and runs `JSON.parse` over it.
  const errored = useMemo(() => isErrorOutput(output), [output]);
  const trigger = useMemo(() => projectSelectTrigger(input, output, errored), [input, output, errored]);
  const openProject = useOpenProjectHandler(part);

  if (errored) {
    return (
      <BasicTool
        disclosureId={disclosureKey('tool', part.id)}
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
      disclosureId={disclosureKey('tool', part.id)}
      icon={FolderIcon}
      trigger={trigger}
      onClick={openProject}
    />
  );
}
ToolRegistry.register('project_select', ProjectSelectTool);
ToolRegistry.register('project-select', ProjectSelectTool);
ToolRegistry.register('oc-project_select', ProjectSelectTool);
ToolRegistry.register('oc-project-select', ProjectSelectTool);

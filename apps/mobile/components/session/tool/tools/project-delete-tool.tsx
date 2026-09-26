/**
 * `project_delete` — port of apps/web `tool/tools/project-delete-tool.tsx`.
 *
 * The row is the whole message ("Workspace · Workspace delete disabled ·
 * <project>") and has no body, so it is a plain row, not a disclosure. Web's
 * file also carries three unused worker-output helpers; they are not ported.
 */

import { TrashIcon } from '@/lib/icons';
import { disclosureKey } from '@/lib/session/disclosure-store';
import { projectDeleteTrigger } from '@/lib/session/tools/projects-projects';
import { BasicTool, partInput } from '../shared/infrastructure';
import { ToolRegistry } from '../shared/registry';
import type { ToolProps } from '../shared/types';

export function ProjectDeleteTool({ part }: ToolProps) {
  return (
    <BasicTool
      disclosureId={disclosureKey('tool', part.id)}
      icon={TrashIcon}
      trigger={projectDeleteTrigger(partInput(part))}
    />
  );
}
ToolRegistry.register('project_delete', ProjectDeleteTool);
ToolRegistry.register('project-delete', ProjectDeleteTool);
ToolRegistry.register('oc-project_delete', ProjectDeleteTool);
ToolRegistry.register('oc-project-delete', ProjectDeleteTool);

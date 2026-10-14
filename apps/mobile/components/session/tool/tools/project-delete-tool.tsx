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

export function ProjectDeleteTool({ call }: ToolProps) {
  return (
    <BasicTool
      disclosureId={disclosureKey('tool', call.id)}
      icon={TrashIcon}
      trigger={projectDeleteTrigger(partInput(call))}
    />
  );
}
ToolRegistry.register('project-delete', ProjectDeleteTool);

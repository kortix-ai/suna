'use client';

// WorkspaceRoleSelectItem — Select option that shows the role name PLUS a one-line
// capability blurb beneath it, while still rendering only the role name in the
// trigger when selected (via SelectItem's description prop).

import { SelectItem } from '@/components/ui/select';
import type { WorkspaceRole } from '@kortix/sdk';
import { WORKSPACE_ROLE_DESCRIPTORS } from './workspace-role-descriptors';

interface Props {
  role: WorkspaceRole;
  /** When true, blurb is hidden — useful in dense secondary dropdowns
   *  (e.g., the "layer a direct grant" select beside an inherited badge). */
  compact?: boolean;
}

export function WorkspaceRoleSelectItem({ role, compact = false }: Props) {
  const descriptor = WORKSPACE_ROLE_DESCRIPTORS[role];
  return (
    <SelectItem value={role} description={compact ? undefined : descriptor.blurb}>
      <span className="font-medium">{descriptor.label}</span>
    </SelectItem>
  );
}

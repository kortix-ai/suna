'use client';

// ProjectRoleSelectItem — Radix Select option that shows the role name PLUS
// a one-line capability blurb beneath it, while still rendering only the
// role name in the trigger when selected.
//
// The trick: SelectPrimitive.ItemText is the slice Radix pulls into the
// trigger via <SelectValue />. Anything OUTSIDE ItemText renders in the
// dropdown list only. So we put the label in ItemText and the blurb as a
// sibling <span> — the dropdown shows two lines, the trigger stays clean
// at one line.
//
// This addresses Marko's "no understanding of Viewer/Editor/Manager"
// feedback: when you open the role dropdown you immediately see what each
// role does, without having to hunt for a help link.

import * as SelectPrimitive from '@radix-ui/react-select';
import { CheckIcon } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { ProjectRole } from '@/lib/projects-client';
import { PROJECT_ROLE_DESCRIPTORS } from './project-role-descriptors';

interface Props {
  role: ProjectRole;
  /** When true, blurb is hidden — useful in dense secondary dropdowns
   *  (e.g., the "layer a direct grant" select beside an inherited badge). */
  compact?: boolean;
}

export function ProjectRoleSelectItem({ role, compact = false }: Props) {
  const descriptor = PROJECT_ROLE_DESCRIPTORS[role];
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      value={role}
      // Same base classes as the default SelectItem in ui/select.tsx, but
      // items-start (vs items-center) so a two-line option lines up the
      // check + label on the first line.
      className={cn(
        "focus:bg-accent focus:text-accent-foreground [&_svg:not([class*='text-'])]:text-muted-foreground relative flex w-full cursor-pointer items-start gap-2 rounded-2xl py-1.5 pr-8 pl-2 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        compact ? 'items-center' : '',
      )}
    >
      <span className="absolute right-2 top-2 flex size-3.5 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <CheckIcon className="size-4" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <SelectPrimitive.ItemText>
          <span className="font-medium">{descriptor.label}</span>
        </SelectPrimitive.ItemText>
        {!compact && (
          <span className="text-[11px] leading-snug text-muted-foreground whitespace-normal max-w-[260px]">
            {descriptor.blurb}
          </span>
        )}
      </div>
    </SelectPrimitive.Item>
  );
}

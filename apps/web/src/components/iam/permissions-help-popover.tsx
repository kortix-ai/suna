'use client';

// "How permissions work" — the single in-app explanation of the role
// model. Same component renders next to the account settings header AND
// next to the project Members header, so newcomers find it regardless of
// where they hit the system first.
//
// Pulls copy from project-role-descriptors so any future role-blurb tweak
// shows up in both the dropdowns and this popover without a sync step.

import { HelpCircle } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  ACCOUNT_ROLE_DESCRIPTORS,
  PROJECT_ROLE_DESCRIPTORS,
  PROJECT_ROLES_ASCENDING,
} from './project-role-descriptors';
import type { AccountRole } from '@/lib/projects-client';

const ACCOUNT_ROLES_DESCENDING: AccountRole[] = ['owner', 'admin', 'member'];

interface Props {
  /** Trigger label. Default fits the account header; project Members uses
   *  the short variant ("Role help") to slot next to a smaller header. */
  triggerLabel?: string;
  align?: 'start' | 'center' | 'end';
}

export function PermissionsHelpPopover({
  triggerLabel = 'How permissions work',
  align = 'end',
}: Props = {}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          <HelpCircle className="h-3.5 w-3.5" />
          {triggerLabel}
        </Button>
      </PopoverTrigger>
      <PopoverContent align={align} className="w-96 space-y-4 text-sm">
        <section className="space-y-1">
          <h3 className="font-semibold text-foreground">Account roles</h3>
          <p className="text-xs text-muted-foreground">
            What a person can do across the whole account.
          </p>
          <ul className="space-y-1 text-xs">
            {ACCOUNT_ROLES_DESCENDING.map((role) => {
              const d = ACCOUNT_ROLE_DESCRIPTORS[role];
              return (
                <li key={role}>
                  <span className="font-medium text-foreground">{d.label}</span>{' '}
                  · {d.blurb}
                </li>
              );
            })}
          </ul>
        </section>

        <section className="space-y-1">
          <h3 className="font-semibold text-foreground">Project roles</h3>
          <p className="text-xs text-muted-foreground">
            What a person can do on a specific project.
          </p>
          <ul className="space-y-1 text-xs">
            {/* Rendered high → low (Manager first) so the most-permissive
             *  role is on top — matches how people usually scan role lists. */}
            {[...PROJECT_ROLES_ASCENDING].reverse().map((role) => {
              const d = PROJECT_ROLE_DESCRIPTORS[role];
              return (
                <li key={role}>
                  <span className="font-medium text-foreground">{d.label}</span>{' '}
                  · {d.summary}
                </li>
              );
            })}
          </ul>
        </section>

        <section className="space-y-1">
          <h3 className="font-semibold text-foreground">Groups</h3>
          <p className="text-xs text-muted-foreground">
            Bundle members and attach the whole group to a project at a
            role. Every group member inherits that role. A user picks up
            the highest role across all their groups + any direct grant.
          </p>
        </section>

        <section className="space-y-1 rounded-2xl border border-amber-500/30 bg-amber-500/5 p-2.5">
          <h3 className="text-xs font-semibold text-amber-700 dark:text-amber-300">
            Override rule
          </h3>
          <p className="text-xs text-muted-foreground">
            Owners and admins always have <strong>Manager</strong> on every
            project, regardless of group attachments. To limit someone to
            specific projects, change their account role to{' '}
            <strong>Member</strong> first.
          </p>
        </section>
      </PopoverContent>
    </Popover>
  );
}

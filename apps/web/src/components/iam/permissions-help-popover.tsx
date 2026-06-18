'use client';

import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { AccountRole } from '@/lib/projects-client';
import { HelpCircle } from 'lucide-react';
import {
  ACCOUNT_ROLE_DESCRIPTORS,
  PROJECT_ROLE_DESCRIPTORS,
  PROJECT_ROLES_ASCENDING,
} from './project-role-descriptors';

const ACCOUNT_ROLES_DESCENDING: AccountRole[] = ['owner', 'admin', 'member'];

interface Props {
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
        <Button variant="secondary" size="sm">
          <HelpCircle className="size-3.5" />
          {triggerLabel}
        </Button>
      </PopoverTrigger>
      <PopoverContent align={align} className="w-96 space-y-4 text-sm">
        <section className="space-y-1">
          <h3 className="text-foreground font-semibold">Account roles</h3>
          <p className="text-muted-foreground text-xs">
            What a person can do across the whole account.
          </p>
          <ul className="space-y-1 text-xs">
            {ACCOUNT_ROLES_DESCENDING.map((role) => {
              const d = ACCOUNT_ROLE_DESCRIPTORS[role];
              return (
                <li key={role}>
                  <span className="text-foreground font-medium">{d.label}</span> · {d.blurb}
                </li>
              );
            })}
          </ul>
        </section>

        <section className="space-y-1">
          <h3 className="text-foreground font-semibold">Project roles</h3>
          <p className="text-muted-foreground text-xs">
            What a person can do on a specific project.
          </p>
          <ul className="space-y-1 text-xs">
            {[...PROJECT_ROLES_ASCENDING].reverse().map((role) => {
              const d = PROJECT_ROLE_DESCRIPTORS[role];
              return (
                <li key={role}>
                  <span className="text-foreground font-medium">{d.label}</span> · {d.summary}
                </li>
              );
            })}
          </ul>
        </section>

        <section className="space-y-1">
          <h3 className="text-foreground font-semibold">Groups</h3>
          <p className="text-muted-foreground text-xs">
            Bundle members and attach the whole group to a project at a role. Every group member
            inherits that role. A user picks up the highest role across all their groups + any
            direct grant.
          </p>
        </section>

        <section className="border-kortix-yellow bg-kortix-yellow/5 space-y-1 rounded-md border p-2.5">
          <h3 className="text-kortix-yellow text-xs font-semibold">Override rule</h3>
          <p className="text-muted-foreground text-xs">
            Owners and admins always have <strong>Manager</strong> on every project, regardless of
            group attachments. To limit someone to specific projects, change their account role to{' '}
            <strong>Member</strong> first.
          </p>
        </section>
      </PopoverContent>
    </Popover>
  );
}

'use client';

import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { AccountRole } from '@/lib/projects-client';
import { HelpCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
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
  const tI18nHardcoded = useTranslations('hardcodedUi');
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
          <h3 className="text-foreground font-semibold">
            {tI18nHardcoded.raw(
              'autoComponentsIamPermissionsHelpPopoverJsxTextAccountRoles567e9b57',
            )}
          </h3>
          <p className="text-muted-foreground text-xs">
            {tI18nHardcoded.raw(
              'autoComponentsIamPermissionsHelpPopoverJsxTextWhatAPerson42f41e4a',
            )}
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
          <h3 className="text-foreground font-semibold">
            {tI18nHardcoded.raw(
              'autoComponentsIamPermissionsHelpPopoverJsxTextProjectRoles38d48ed3',
            )}
          </h3>
          <p className="text-muted-foreground text-xs">
            {tI18nHardcoded.raw(
              'autoComponentsIamPermissionsHelpPopoverJsxTextWhatAPerson5b13fd4a',
            )}
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
            {tI18nHardcoded.raw(
              'autoComponentsIamPermissionsHelpPopoverJsxTextBundleMembersAndd44ada52',
            )}
          </p>
        </section>

        <section className="border-kortix-yellow bg-kortix-yellow/5 space-y-1 rounded-md border p-2.5">
          <h3 className="text-kortix-yellow text-xs font-semibold">
            {tI18nHardcoded.raw(
              'autoComponentsIamPermissionsHelpPopoverJsxTextOverrideRule60f7c767',
            )}
          </h3>
          <p className="text-muted-foreground text-xs">
            {tI18nHardcoded.raw(
              'autoComponentsIamPermissionsHelpPopoverJsxTextOwnersAndAdmins9e16f219',
            )}
            <strong>Manager</strong>{' '}
            {tI18nHardcoded.raw(
              'autoComponentsIamPermissionsHelpPopoverJsxTextOnEveryProject7532e737',
            )}{' '}
            <strong>Member</strong> first.
          </p>
        </section>
      </PopoverContent>
    </Popover>
  );
}

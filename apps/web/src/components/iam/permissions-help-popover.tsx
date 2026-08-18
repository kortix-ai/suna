'use client';

import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { AccountRole } from '@kortix/sdk';
import { QuestionIcon as HelpCircle } from '@phosphor-icons/react';
import Link from 'next/link';
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
  /**
   * Shows the "Custom roles" section with a real link to
   * `/accounts/<accountId>?tab=roles`, ONLY when passed. The account page's
   * own mount (`accounts/[id]/page.tsx`) omits this — a "manage roles" link
   * to the page the popover is already open on is a link to nowhere new.
   * Project-scoped mounts (`members-tab.tsx`) pass it: this is the one place
   * a person reading "how do project roles work" would otherwise never learn
   * custom roles exist at all, now that the project-level Access tab shows
   * only agent assignment — group-role and custom-role binding moved to
   * their account-level homes (see `members-tab.tsx`'s header comment).
   */
  accountId?: string;
}

export function PermissionsHelpPopover({
  triggerLabel = 'How permissions work',
  align = 'start',
  accountId,
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
      <PopoverContent align={align} side="right" className="w-96 space-y-4 text-sm">
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

        {accountId ? (
          <section className="space-y-1">
            <h3 className="text-foreground font-semibold">Custom roles</h3>
            <p className="text-muted-foreground text-xs">
              For a permission set beyond these three tiers. Defined once on
              the account, then bound to a member, group, or agent — either
              account-wide, or to just this project.{' '}
              <Link
                href={`/accounts/${accountId}?tab=roles`}
                className="text-foreground underline underline-offset-2"
              >
                Manage roles
              </Link>
              .
            </p>
          </section>
        ) : null}

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

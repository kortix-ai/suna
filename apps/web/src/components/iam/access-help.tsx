'use client';

import { useTranslations } from '@/i18n/use-translations';
// AccessHelp — the "how access works" reference, mounted as a real pane
// (`/accounts/[id]?tab=help`) instead of the old `PermissionsHelpPopover`.
//
// A popover in the rail footer could not be linked to, could not be read
// beside the list it explains, and hid its own "Custom roles" section behind
// an `accountId` prop the only mount never passed. This is the same copy,
// rewritten to the unified 3-noun model (principal · scope · role) and laid
// out as plain page sections.
//
// Every role blurb comes from `ACCOUNT_ROLE_DESCRIPTORS` /
// `PROJECT_ROLE_DESCRIPTORS` in `features/workspace/shared/access` — the same
// source `RoleSelect` renders in the dialog, so the help text and the picker
// can never drift.

import Link from 'next/link';

import {
  ACCOUNT_ROLES_ASCENDING,
  builtinRoleDescriptor,
  type OfferedProjectRole,
  PROJECT_ROLES_ASCENDING,
} from '@/features/workspace/shared/access';
import type { AccountRole } from '@kortix/sdk';

const ACCOUNT_ROLES_DESCENDING = [...ACCOUNT_ROLES_ASCENDING].reverse() as AccountRole[];
const PROJECT_ROLES_DESCENDING = [...PROJECT_ROLES_ASCENDING].reverse() as OfferedProjectRole[];

const PANEL = 'bg-popover rounded-md border';

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="space-y-1">
        <h3 className="text-foreground text-sm font-medium">{title}</h3>
        {description ? <p className="text-muted-foreground text-sm">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

function RoleList({ rows }: { rows: Array<{ key: string; label: string; summary: string }> }) {
  return (
    <ul className={`${PANEL} divide-border divide-y`}>
      {rows.map((row) => (
        <li key={row.key} className="space-y-0.5 px-4 py-3">
          <p className="text-foreground text-sm font-medium">{row.label}</p>
          <p className="text-muted-foreground text-xs leading-relaxed">{row.summary}</p>
        </li>
      ))}
    </ul>
  );
}

export interface AccessHelpProps {
  accountId: string;
}

export function AccessHelp({ accountId }: AccessHelpProps) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return (
    <div className="space-y-8">
      <Section
        title={tI18nComplete.raw('text1ba70b3e6cfc')}
        description={tI18nComplete.raw('textefc24d019a32')}
      >
        <div className={`${PANEL} divide-border divide-y`}>
          <div className="space-y-0.5 px-4 py-3">
            <p className="text-foreground text-sm font-medium">
              {tI18nComplete.raw('textafc19f1734c1')}
            </p>
            <p className="text-muted-foreground text-xs leading-relaxed">
              {tI18nComplete.raw('textcefeb25cde11')}
            </p>
          </div>
          <div className="space-y-0.5 px-4 py-3">
            <p className="text-foreground text-sm font-medium">
              {tI18nComplete.raw('text14736a2eb9f4')}
            </p>
            <p className="text-muted-foreground text-xs leading-relaxed">
              {tI18nComplete.raw('text100a17657e7b')}
            </p>
          </div>
          <div className="space-y-0.5 px-4 py-3">
            <p className="text-foreground text-sm font-medium">
              {tI18nComplete.raw('textb073f6c68ef8')}
            </p>
            <p className="text-muted-foreground text-xs leading-relaxed">
              {tI18nComplete.raw('text0b9bc3b34bd0')}
            </p>
          </div>
          <div className="space-y-0.5 px-4 py-3">
            <p className="text-foreground text-sm font-medium">
              {tI18nComplete.raw('text153cdaaec561')}
            </p>
            <p className="text-muted-foreground text-xs leading-relaxed">
              {tI18nComplete.raw('textae553394b31a')}
            </p>
          </div>
        </div>
      </Section>

      <Section
        title={tI18nComplete.raw('text49c8061192c7')}
        description={tI18nComplete.raw('text8131497474c7')}
      >
        <RoleList
          rows={ACCOUNT_ROLES_DESCENDING.map((role) => ({
            key: role,
            label: builtinRoleDescriptor('account', role, tI18nComplete)!.label,
            summary: builtinRoleDescriptor('account', role, tI18nComplete)!.summary,
          }))}
        />
      </Section>

      <Section
        title={tI18nComplete.raw('text31b7c5d19327')}
        description={tI18nComplete.raw('text7cb19495b4ab')}
      >
        <RoleList
          rows={PROJECT_ROLES_DESCENDING.map((role) => ({
            key: role,
            label: builtinRoleDescriptor('project', role, tI18nComplete)!.label,
            summary: builtinRoleDescriptor('project', role, tI18nComplete)!.summary,
          }))}
        />
      </Section>

      <Section title={tI18nComplete.raw('textc703c7f9cbe6')}>
        <div className={`${PANEL} space-y-2 px-4 py-3`}>
          <p className="text-muted-foreground text-xs leading-relaxed">
            {tI18nComplete.raw('text118749e29c68')}
          </p>
          <p className="text-muted-foreground text-xs leading-relaxed">
            {tI18nComplete.raw('text147d3ae89e52')}
          </p>
          <Link
            href={`/accounts/${accountId}?tab=roles`}
            className="text-foreground inline-block text-xs underline underline-offset-2"
          >
            {tI18nComplete.raw('textc2718d67695f')}
          </Link>
        </div>
      </Section>

      <Section title={tI18nComplete.raw('text39bbb719fa2b')}>
        <div className={`${PANEL} space-y-2 px-4 py-3`}>
          <p className="text-muted-foreground text-xs leading-relaxed">
            {tI18nComplete.raw('texte82c81f0607b')}
          </p>
          <p className="text-muted-foreground text-xs leading-relaxed">
            {tI18nComplete.raw('text2ea23e8c03fa')}
          </p>
        </div>
      </Section>

      <Section title={tI18nComplete.raw('text279b44d2ab4b')}>
        <div className={`${PANEL} space-y-2 px-4 py-3`}>
          <p className="text-muted-foreground text-xs leading-relaxed">
            {tI18nComplete.raw('textc2dfb2c0eb28')}
          </p>
          <p className="text-muted-foreground text-xs leading-relaxed">
            {tI18nComplete.raw('text3c3b223b35e3')}
          </p>
          <p className="text-muted-foreground text-xs leading-relaxed">
            {tI18nComplete.raw('text668cedb7be4b')}
            <code className="text-foreground text-xs">kortix.yaml</code>
            {tI18nComplete.raw('text18c99d7a5ce2')}
          </p>
          <p className="text-foreground text-xs leading-relaxed">
            {tI18nComplete.raw('textec56dc3a282b')}{' '}
            <code className="text-foreground text-xs">kortix.yaml</code>
            {tI18nComplete.raw('textfe384b93382f')}
          </p>
        </div>
      </Section>

      <Section title={tI18nComplete.raw('text29f30b14dfba')}>
        <div className="border-kortix-yellow bg-kortix-yellow/5 space-y-1 rounded-md border p-4">
          <p className="text-kortix-yellow text-xs font-medium">
            {tI18nComplete.raw('text3e26769ed36a')}
          </p>
          <p className="text-muted-foreground text-xs leading-relaxed">
            {tI18nComplete.raw('texta651830bc408')}
          </p>
        </div>
      </Section>
    </div>
  );
}

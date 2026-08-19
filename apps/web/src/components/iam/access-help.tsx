'use client';

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
  ACCOUNT_ROLE_DESCRIPTORS,
  type OfferedProjectRole,
  PROJECT_ROLES_ASCENDING,
  PROJECT_ROLE_DESCRIPTORS,
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
  return (
    <div className="space-y-8">
      <Section
        title="The model"
        description="Three things decide what someone can do: who they are, where, and with which role."
      >
        <div className={`${PANEL} divide-border divide-y`}>
          <div className="space-y-0.5 px-4 py-3">
            <p className="text-foreground text-sm font-medium">Principal</p>
            <p className="text-muted-foreground text-xs leading-relaxed">
              A person, a group, or an email you invited that has not joined yet.
            </p>
          </div>
          <div className="space-y-0.5 px-4 py-3">
            <p className="text-foreground text-sm font-medium">Scope</p>
            <p className="text-muted-foreground text-xs leading-relaxed">
              The account, or one project. A group holds one role per project it is attached to.
            </p>
          </div>
          <div className="space-y-0.5 px-4 py-3">
            <p className="text-foreground text-sm font-medium">Role</p>
            <p className="text-muted-foreground text-xs leading-relaxed">
              Exactly one role per principal per scope — a built-in role or a custom one. Change it
              from any row&apos;s Edit access.
            </p>
          </div>
        </div>
      </Section>

      <Section
        title="Account roles"
        description="What a person can do with the account itself — its name, its billing, and its people."
      >
        <RoleList
          rows={ACCOUNT_ROLES_DESCENDING.map((role) => ({
            key: role,
            label: ACCOUNT_ROLE_DESCRIPTORS[role].label,
            summary: ACCOUNT_ROLE_DESCRIPTORS[role].summary,
          }))}
        />
      </Section>

      <Section
        title="Project roles"
        description="What a person can do inside one project. Granted directly, or inherited from a group attached to that project."
      >
        <RoleList
          rows={PROJECT_ROLES_DESCENDING.map((role) => ({
            key: role,
            label: PROJECT_ROLE_DESCRIPTORS[role].label,
            summary: PROJECT_ROLE_DESCRIPTORS[role].summary,
          }))}
        />
      </Section>

      <Section title="Custom roles">
        <div className={`${PANEL} space-y-2 px-4 py-3`}>
          <p className="text-muted-foreground text-xs leading-relaxed">
            For a permission set the built-in roles do not cover. You define a custom role once
            on the account, then pick it in the same role select as the built-in ones — on a member,
            on a group, account-wide or on one project.
          </p>
          <p className="text-muted-foreground text-xs leading-relaxed">
            A custom role is additive: the principal keeps the lowest built-in role for that scope,
            and the custom role grants everything on top. Choosing a built-in role again removes it.
          </p>
          <Link
            href={`/accounts/${accountId}?tab=roles`}
            className="text-foreground inline-block text-xs underline underline-offset-2"
          >
            Manage roles →
          </Link>
        </div>
      </Section>

      <Section title="Groups">
        <div className={`${PANEL} space-y-2 px-4 py-3`}>
          <p className="text-muted-foreground text-xs leading-relaxed">
            A group bundles people so you grant access once instead of per person. Attach a group to
            a project with a role, and every member of that group gets that role on that project.
          </p>
          <p className="text-muted-foreground text-xs leading-relaxed">
            Group access adds to what a person already has — it never takes access away. Remove
            someone&apos;s direct grant and they keep whatever their groups still give them.
          </p>
        </div>
      </Section>

      <Section title="Agents">
        <div className={`${PANEL} space-y-2 px-4 py-3`}>
          <p className="text-muted-foreground text-xs leading-relaxed">
            Agents are a project resource, not a principal. Everyone with project access reaches all
            of the project&apos;s agents by default; narrow that to a subset in Edit access under
            Agents.
          </p>
          <p className="text-muted-foreground text-xs leading-relaxed">
            Whoever can reach an agent also gets the agent&apos;s declared secrets and connectors to
            USE, not to edit.
          </p>
          <p className="text-muted-foreground text-xs leading-relaxed">
            What a RUNNING agent itself is allowed to touch is a different question — that comes from
            the project&apos;s <code className="text-foreground text-[11px]">kortix.yaml</code>, not
            from anything on this page.
          </p>
          <p className="text-foreground text-xs leading-relaxed">
            People get roles. Agents get Kortix CLI scopes in{' '}
            <code className="text-foreground text-[11px]">kortix.yaml</code>. A session can only do
            what both allow.
          </p>
        </div>
      </Section>

      <Section title="Override rule">
        <div className="border-kortix-yellow bg-kortix-yellow/5 space-y-1 rounded-md border p-4">
          <p className="text-kortix-yellow text-xs font-medium">
            Owners and admins are Manager on every project.
          </p>
          <p className="text-muted-foreground text-xs leading-relaxed">
            Their account role wins, so a per-project grant cannot lower it. To limit what someone
            reaches project by project, make them a Member on the account first.
          </p>
        </div>
      </Section>
    </div>
  );
}

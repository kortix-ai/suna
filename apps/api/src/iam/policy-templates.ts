// Curated policy templates ("blueprints"). Each template names a set of
// policies that get materialised against a chosen principal — the IAM
// equivalent of an installer. v1 ships a small server-side catalog; a
// future revision can add user-defined templates stored per account.
//
// Templates resolve role-by-key against the system roles, so they're
// stable across schema migrations (system role IDs aren't).

import { and, isNull, inArray } from 'drizzle-orm';
import { iamRoles } from '@kortix/db';
import { db } from '../shared/db';
import { SYSTEM_ROLE_KEY } from './system-roles';
import { createPolicy } from '../repositories/iam';

export interface PolicyTemplate {
  key: string;
  name: string;
  description: string;
  /** Each entry materialises one policy. scope_id is filled in by the
   *  caller at apply time (member or token or project picker). */
  entries: Array<{
    roleKey: string;
    scopeType: 'account' | 'project' | 'project_group';
    /** Notes shown alongside the template entry in the preview UI. */
    note?: string;
  }>;
  /** Hint to the UI: which principal types make sense for this
   *  template. The Apply dialog narrows its picker accordingly. */
  appliesTo: Array<'member' | 'group' | 'token'>;
  /** Hint to the UI: when entries reference a project / project_group
   *  scope, do we need ONE id for all entries or per-entry? v1
   *  templates assume one resource per apply for simplicity. */
  needsScopeId: 'account' | 'project' | 'project_group';
}

export const POLICY_TEMPLATES: PolicyTemplate[] = [
  {
    key: 'ci-cd-bot',
    name: 'CI/CD bot — single project',
    description:
      'Read + write + sandbox exec on one project. Apply to a service account or PAT that drives deploys for that project only.',
    entries: [
      {
        roleKey: SYSTEM_ROLE_KEY.PROJECT_EDITOR,
        scopeType: 'project',
        note: 'Read + write project files, run sandboxes',
      },
    ],
    appliesTo: ['token'],
    needsScopeId: 'project',
  },
  {
    key: 'project-readonly-auditor',
    name: 'Read-only auditor — single project',
    description:
      'Read-only access to one project (no execute, no write). Good baseline for compliance reviewers or external auditors.',
    entries: [
      {
        roleKey: SYSTEM_ROLE_KEY.PROJECT_VIEWER,
        scopeType: 'project',
      },
    ],
    appliesTo: ['member', 'group', 'token'],
    needsScopeId: 'project',
  },
  {
    key: 'team-lead',
    name: 'Team lead — project group',
    description:
      'Admin on every project in a project group. Use for engineering managers who should manage their team\'s projects without account-wide reach.',
    entries: [
      {
        roleKey: SYSTEM_ROLE_KEY.PROJECT_ADMIN,
        scopeType: 'project_group',
        note: 'Project admin on every project in the chosen group',
      },
    ],
    appliesTo: ['member', 'group'],
    needsScopeId: 'project_group',
  },
  {
    key: 'observer',
    name: 'Account observer — read everything',
    description:
      'Account-wide read across members, groups, audit log, projects. No mutations. Common for SRE / on-call viewers.',
    entries: [
      {
        roleKey: SYSTEM_ROLE_KEY.ADMINISTRATOR_READ_ONLY,
        scopeType: 'account',
      },
    ],
    appliesTo: ['member', 'group'],
    needsScopeId: 'account',
  },
];

export function getTemplate(key: string): PolicyTemplate | null {
  return POLICY_TEMPLATES.find((t) => t.key === key) ?? null;
}

/**
 * Apply a template's entries as concrete policies for one principal.
 * `scopeId` is required for non-account templates and provides the
 * project / project_group id every entry resolves to.
 *
 * Returns the materialised policies + a list of skipped entries
 * (e.g. role lookup failed) so the UI can show a precise result.
 */
export async function applyTemplate(args: {
  template: PolicyTemplate;
  accountId: string;
  principalType: 'member' | 'group' | 'token';
  principalId: string;
  scopeId: string | null;
  createdBy: string;
}): Promise<{
  created: Array<{ role_key: string; policy_id: string }>;
  skipped: Array<{ role_key: string; reason: string }>;
}> {
  const { template, accountId, principalType, principalId, scopeId, createdBy } = args;
  if (template.needsScopeId !== 'account' && !scopeId) {
    throw new Error('scope_id is required for this template');
  }
  if (!template.appliesTo.includes(principalType)) {
    throw new Error(
      `template ${template.key} cannot be applied to a ${principalType} principal`,
    );
  }

  // Resolve role keys to ids in one query so we don't fan out N requests.
  const keys = Array.from(new Set(template.entries.map((e) => e.roleKey)));
  const roleRows = await db
    .select({ key: iamRoles.key, roleId: iamRoles.roleId })
    .from(iamRoles)
    .where(and(isNull(iamRoles.accountId), inArray(iamRoles.key, keys)));
  const idByKey = new Map(roleRows.map((r) => [r.key, r.roleId] as const));

  const created: Array<{ role_key: string; policy_id: string }> = [];
  const skipped: Array<{ role_key: string; reason: string }> = [];

  for (const entry of template.entries) {
    const roleId = idByKey.get(entry.roleKey);
    if (!roleId) {
      skipped.push({ role_key: entry.roleKey, reason: 'system role not found' });
      continue;
    }
    try {
      // Cast — createPolicy accepts the full PolicyScopeType set.
      const policy = await createPolicy({
        accountId,
        principalType,
        principalId,
        scopeType: entry.scopeType,
        scopeId: entry.scopeType === 'account' ? null : scopeId,
        roleId,
        effect: 'allow',
        createdBy,
      });
      created.push({ role_key: entry.roleKey, policy_id: policy.policyId });
    } catch (err) {
      // We don't know the inner error code from a wrapped Postgres error
      // up here without sniffing — surface the message for the audit
      // log and keep going on the remaining entries.
      skipped.push({
        role_key: entry.roleKey,
        reason: (err as Error).message ?? 'unknown error',
      });
    }
  }

  return { created, skipped };
}


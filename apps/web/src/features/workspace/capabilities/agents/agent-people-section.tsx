'use client';

/**
 * Who may use this agent — managed here, on the agent's page.
 *
 * This is THE access path in Kortix: a project manager grants a person or a
 * group an agent, never a skill or a secret directly (`object_policies` marks
 * `agent` closed and everything else open — `apps/api/src/iam/authorize.ts`),
 * and the person inherits the agent's connectors and secrets through it.
 * That is why the agent is the object Customize is built around, and why
 * granting happens on the agent's own page instead of a hop to the account's
 * Access hub (Marko, 2026-09-03: "directly inside you should be able to
 * choose who has access").
 *
 * The rows are the resource grants that name this agent, one per principal.
 * Both actions open the shared `AccessDialog` — the same dialog the Access
 * hub uses, so a grant made here and one made there are the same rows with
 * the same rules:
 *
 *  - **Grant access** opens it in grant mode with the agent picker already
 *    narrowed to this agent (`initialAgentIds`). Pick people or groups, a
 *    role, an expiry; done.
 *  - **Edit** on a row opens it in edit mode for that principal, seeded with
 *    their current role and every agent they hold — so widening or removing
 *    goes through the dialog's diff, never a bare delete. A bare delete of
 *    the last grant would widen the principal to EVERY agent (no object
 *    grants = unscoped), which is the opposite of what "remove" means.
 *
 * Gated on `project.members.manage`, the leaf the grants endpoint asserts.
 * Someone without it sees nothing rather than a section that 403s.
 */

import { Button } from '@/components/ui/button';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { UserAvatar } from '@/components/ui/user-avatar';
import { EditorSection } from '@/features/workspace/customize/sections/view/agent-editor-primitives';
import {
  AccessDialog,
  type AccessDialogCurrent,
  type AccessDialogPrincipal,
} from '@/features/workspace/shared/access/access-dialog';
import { builtinRole, customRole, ROLE_NONE } from '@/features/workspace/shared/access/role-select';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import {
  getProjectDetail,
  listProjectAccess,
  listProjectResourceGrants,
  type ProjectAccessMember,
  type ProjectAccessResponse,
  type ProjectResourceGrant,
  type ProjectRole,
  type ResourceGrantType,
} from '@kortix/sdk';
import { contract, qk, useProjectAccountId } from '@kortix/sdk/react';
import { PencilSimpleIcon, PlusIcon, UsersIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

/** The grants that name `agentName`. Orphaned rows (agent renamed) are kept —
 *  they are inert, and hiding them would hide the thing to clean up.
 *  `resourceType` defaults to `'agent'`, so every existing caller is unchanged;
 *  a subproject page passes `'subproject'` and gets the identical fold. */
export function grantsForAgent(
  grants: readonly ProjectResourceGrant[],
  agentName: string,
  resourceType: ResourceGrantType = 'agent',
): ProjectResourceGrant[] {
  return grants.filter((g) => g.resource_type === resourceType && g.resource_id === agentName);
}

/** Every object of one type a principal holds — the edit dialog's `agentIds` /
 *  `subprojectIds` seed. */
export function agentIdsHeldBy(
  grants: readonly ProjectResourceGrant[],
  principalType: 'member' | 'group',
  principalId: string,
  resourceType: ResourceGrantType = 'agent',
): string[] {
  return [
    ...new Set(
      grants
        .filter(
          (g) =>
            g.resource_type === resourceType &&
            g.principal_type === principalType &&
            g.principal_id === principalId,
        )
        .map((g) => g.resource_id),
    ),
  ];
}

/** The section's copy, per resource type. The two objects the IAM engine
 *  closes by default are granted the same way, so they get the same section
 *  with the sentence that names what is actually inherited. */
const RESOURCE_COPY: Record<
  'agent' | 'subproject',
  { description: string; empty: string; rowSuffix: string }
> = {
  agent: {
    description:
      'Members and groups granted this agent. They inherit its connectors and secrets as their own.',
    empty: 'No one is granted this agent yet. Project managers can always use it.',
    rowSuffix: 'grant no longer matches an agent',
  },
  subproject: {
    description:
      'Members and groups granted this subproject. A subproject grant is not an agent grant — they need its agent in their own right too.',
    empty: 'No one is granted this subproject yet. Project managers can always use it.',
    rowSuffix: 'grant no longer matches a subproject',
  },
};

// The live `/access` contract carries a custom-role binding per member and a
// `group_access` array the SDK type does not yet declare — the same gap
// `components/iam/access-projects-tab.tsx` bridges with its own local types.
interface CustomRolePolicyEntry {
  role_id: string;
  role_name: string;
  expires_at: string | null;
  scope_type?: 'account' | 'project';
}
interface ExtendedAccessMember extends ProjectAccessMember {
  custom_role_policies?: CustomRolePolicyEntry[];
}
interface GroupAccessRow {
  group_id: string;
  group_name: string | null;
  built_in_role: ProjectRole | null;
  custom_role_policies?: CustomRolePolicyEntry[];
}
interface ExtendedAccessResponse extends ProjectAccessResponse {
  members: ExtendedAccessMember[];
  group_access?: GroupAccessRow[];
}

/** The project-scoped custom-role binding, if the principal has one. */
function projectPolicy(policies: CustomRolePolicyEntry[] | undefined) {
  return policies?.find((p) => p.scope_type !== 'account') ?? null;
}

interface EditTarget {
  principal: AccessDialogPrincipal;
  current: AccessDialogCurrent;
  inheritedFrom?: string[];
}

export function AgentPeopleSection({
  projectId,
  agentName,
  resourceType = 'agent',
}: {
  projectId: string;
  /** The grant key: an agent name, or a subproject slug. */
  agentName: string;
  /** Which closed object type this section grants. Defaults to `'agent'`, so
   *  the agent page's two call sites are unchanged. */
  resourceType?: 'agent' | 'subproject';
}) {
  const copy = RESOURCE_COPY[resourceType];
  const canManage =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE).allowed === true;
  const accountId = useProjectAccountId(projectId);
  const [grantOpen, setGrantOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const [editOpen, setEditOpen] = useState(false);

  const grantsQuery = useQuery({
    queryKey: qk.project.resourceGrants(projectId),
    queryFn: () => listProjectResourceGrants(projectId),
    enabled: canManage,
    retry: false,
    ...contract('inventory'),
  });
  // The roster, for each row's current role — what the edit dialog seeds
  // from. Same key as everywhere else the roster is read, so a save in the
  // dialog refreshes it here through the dialog's own invalidation.
  const accessQuery = useQuery({
    queryKey: qk.project.access(projectId),
    queryFn: () => listProjectAccess(projectId) as Promise<ExtendedAccessResponse>,
    enabled: canManage,
    ...contract('inventory'),
  });
  const detailQuery = useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
    ...contract('config'),
  });
  const projectName = detailQuery.data?.project?.name ?? '';

  const grants = useMemo(() => grantsQuery.data?.grants ?? [], [grantsQuery.data]);
  const assigned = useMemo(
    () => grantsForAgent(grants, agentName, resourceType),
    [grants, agentName, resourceType],
  );

  if (!canManage) return null;

  const openEdit = (grant: ProjectResourceGrant) => {
    // BOTH object types are seeded, whichever page this section is on: the
    // dialog's diff writes only what changed, and a `current` missing the
    // other type would leave that picker showing "All" while the principal
    // actually holds a subset.
    const agentIds = agentIdsHeldBy(grants, grant.principal_type, grant.principal_id, 'agent');
    const subprojectIds = agentIdsHeldBy(
      grants,
      grant.principal_type,
      grant.principal_id,
      'subproject',
    );
    if (grant.principal_type === 'member') {
      const member = accessQuery.data?.members.find((m) => m.user_id === grant.principal_id);
      const policy = projectPolicy(member?.custom_role_policies);
      setEditTarget({
        principal: {
          type: 'member',
          id: grant.principal_id,
          label: grant.principal_label,
          avatar: <UserAvatar email={member?.email ?? grant.principal_label} size="sm" />,
        },
        current: {
          role: policy
            ? customRole(policy.role_id)
            : member?.project_role
              ? builtinRole(member.project_role)
              : ROLE_NONE,
          agentIds: agentIds.length > 0 ? agentIds : 'all',
          subprojectIds: subprojectIds.length > 0 ? subprojectIds : 'all',
          expiresAt: policy ? policy.expires_at : (member?.expires_at ?? null),
        },
        inheritedFrom: (member?.group_sources ?? []).map((g) => g.group_name),
      });
    } else {
      const group = accessQuery.data?.group_access?.find((g) => g.group_id === grant.principal_id);
      const policy = projectPolicy(group?.custom_role_policies);
      setEditTarget({
        principal: {
          type: 'group',
          id: grant.principal_id,
          label: grant.principal_label,
          avatar: <EntityAvatar icon={UsersIcon} size="sm" />,
        },
        current: {
          role: policy
            ? customRole(policy.role_id)
            : group?.built_in_role
              ? builtinRole(group.built_in_role)
              : ROLE_NONE,
          agentIds: agentIds.length > 0 ? agentIds : 'all',
          subprojectIds: subprojectIds.length > 0 ? subprojectIds : 'all',
          expiresAt: policy ? policy.expires_at : null,
        },
      });
    }
    setEditOpen(true);
  };

  return (
    <EditorSection title="Who can use it" description={copy.description}>
      <div className="space-y-3 py-3.5">
        {grantsQuery.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-11 w-full rounded-md" />
            <Skeleton className="h-11 w-full rounded-md" />
          </div>
        ) : assigned.length === 0 ? (
          <p className="text-muted-foreground text-xs text-pretty">{copy.empty}</p>
        ) : (
          <ul className="space-y-2">
            {assigned.map((g) => {
              const member =
                g.principal_type === 'member'
                  ? accessQuery.data?.members.find((m) => m.user_id === g.principal_id)
                  : undefined;
              return (
                <li
                  key={g.grant_id}
                  className="group bg-popover flex items-center gap-3 rounded-md border px-3 py-2"
                >
                  {g.principal_type === 'group' ? (
                    <EntityAvatar icon={UsersIcon} size="md" />
                  ) : (
                    <UserAvatar email={member?.email ?? g.principal_label} size="md" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="text-foreground block truncate text-sm font-medium">
                      {g.principal_label}
                    </span>
                    <span className="text-muted-foreground block truncate text-xs">
                      {g.principal_type === 'group' ? 'Group' : 'Member'}
                      {g.expires_at
                        ? ` · until ${new Date(g.expires_at).toLocaleDateString()}`
                        : ''}
                      {g.orphaned ? ` · ${copy.rowSuffix}` : ''}
                    </span>
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="gap-1.5"
                    onClick={() => openEdit(g)}
                    disabled={!accountId}
                  >
                    <PencilSimpleIcon className="size-3.5 shrink-0" />
                    Edit
                  </Button>
                </li>
              );
            })}
          </ul>
        )}

        {accountId ? (
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => setGrantOpen(true)}
          >
            <PlusIcon className="size-3.5 shrink-0" />
            Grant access
          </Button>
        ) : null}
      </div>

      {accountId ? (
        <AccessDialog
          open={grantOpen}
          onOpenChange={setGrantOpen}
          accountId={accountId}
          scope={{ kind: 'project', projectId, projectName }}
          mode={{ kind: 'grant' }}
          {...(resourceType === 'subproject'
            ? { initialSubprojectIds: [agentName] }
            : { initialAgentIds: [agentName] })}
        />
      ) : null}

      {accountId && editTarget ? (
        <AccessDialog
          key={`${editTarget.principal.type}:${editTarget.principal.id}`}
          open={editOpen}
          onOpenChange={setEditOpen}
          accountId={accountId}
          scope={{ kind: 'project', projectId, projectName }}
          mode={{ kind: 'edit', principal: editTarget.principal, current: editTarget.current }}
          inheritedFrom={editTarget.inheritedFrom}
        />
      ) : null}
    </EditorSection>
  );
}

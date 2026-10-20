'use client';
import { useAgentGrants } from './use-agent-grants';

import { useTranslations as useI18nTranslations } from '../../i18n';
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

import { Button } from '../../primitives/button';
import { ConfirmDialog } from '../../primitives/confirm-dialog';
import { EntityAvatar } from '../../primitives/entity-avatar';
import { Skeleton } from '../../primitives/skeleton';
import { errorToast, successToast } from '../../primitives/toast';
import { UserAvatar } from '../../primitives/user-avatar';
import { EditorSection } from '../sections/view/agent-editor-primitives';
import {
  AccessDialog,
  type AccessDialogCurrent,
  type AccessDialogPrincipal,
} from '../../access/access/access-dialog';
import { builtinRole, customRole, ROLE_NONE } from '../../access/access/role-select';
import { PROJECT_ACTIONS } from '../../internal/lib/project-actions';
import { useProjectCan } from '../../internal/lib/use-project-can';
import {
  deleteProjectResourceGrant,
  listProjectAccess,
  type ProjectAccessMember,
  type ProjectAccessResponse,
  type ProjectResourceGrant,
} from '@kortix/sdk';
import {
  contract,
  invalidatePermissionProbes,
  qk,
  useProjectAccountId,
  useProjectName,
} from '@kortix/sdk/react';
import { PencilSimpleIcon, PlusIcon, UsersIcon, UsersThreeIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

/** The grants that name `agentName`. Orphaned rows (agent renamed) are kept —
 *  they are inert, and hiding them would hide the thing to clean up. */
export function grantsForAgent(
  grants: readonly ProjectResourceGrant[],
  agentName: string,
): ProjectResourceGrant[] {
  return grants.filter((g) => g.resource_type === 'agent' && g.resource_id === agentName);
}

/** Every agent a principal holds — the edit dialog's `agentIds` seed. */
function agentIdsHeldBy(
  grants: readonly ProjectResourceGrant[],
  principalType: 'member' | 'group',
  principalId: string,
): string[] {
  return [
    ...new Set(
      grants
        .filter(
          (g) =>
            g.resource_type === 'agent' &&
            g.principal_type === principalType &&
            g.principal_id === principalId,
        )
        .map((g) => g.resource_id),
    ),
  ];
}

/** The project-scoped custom-role binding, if the principal has one. */
function projectPolicy(policies: ProjectAccessMember['custom_role_policies'] | NonNullable<ProjectAccessResponse['group_access']>[number]['custom_role_policies'] | undefined) {
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
}: {
  projectId: string;
  agentName: string;
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const tSharing = useI18nTranslations('accessSharing');
  const queryClient = useQueryClient();
  const canManage =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE).allowed === true;
  const accountId = useProjectAccountId(projectId);
  const [grantOpen, setGrantOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const [editOpen, setEditOpen] = useState(false);

  const grantsQuery = useAgentGrants(projectId, canManage); // The roster, for each row's current role — what the edit dialog seeds
  // from. Same key as everywhere else the roster is read, so a save in the
  // dialog refreshes it here through the dialog's own invalidation.
  const accessQuery = useQuery({
    queryKey: qk.project.access(projectId),
    queryFn: () => listProjectAccess(projectId),
    enabled: canManage,
    ...contract('inventory'),
  });
  const projectName = useProjectName(projectId) ?? '';

  const grants = useMemo(() => grantsQuery.data?.grants ?? [], [grantsQuery.data]);
  const assigned = useMemo(() => grantsForAgent(grants, agentName), [grants, agentName]);

  // A grant to everyone in the project has no role to edit: its only action is
  // to stop sharing, which removes that one grant.
  const [stopSharing, setStopSharing] = useState<ProjectResourceGrant | null>(null);
  const stopSharingMutation = useMutation({
    mutationFn: (grantId: string) => deleteProjectResourceGrant(projectId, grantId),
    onSuccess: () => {
      successToast(tSharing('removed'));
      if (accountId) void invalidatePermissionProbes(queryClient, { accountId });
      queryClient.invalidateQueries({ queryKey: qk.project.scope(projectId) });
      setStopSharing(null);
    },
    onError: (error: Error) => errorToast(error.message || tSharing('removeFailed')),
  });

  if (!canManage) return null;

  const openEdit = (grant: ProjectResourceGrant) => {
    if (grant.principal_type === 'project') return;
    const agentIds = agentIdsHeldBy(grants, grant.principal_type, grant.principal_id);
    const member =
      grant.principal_type === 'member'
        ? accessQuery.data?.members.find((m) => m.user_id === grant.principal_id)
        : undefined;
    const group =
      grant.principal_type === 'group'
        ? accessQuery.data?.group_access?.find((g) => g.group_id === grant.principal_id)
        : undefined;
    const policy = projectPolicy(member?.custom_role_policies ?? group?.custom_role_policies);
    const role = member?.project_role ?? group?.built_in_role;
    setEditTarget({
      principal: {
        type: grant.principal_type,
        id: grant.principal_id,
        label: grant.principal_label,
        avatar:
          member || grant.principal_type === 'member' ? (
            <UserAvatar email={member?.email ?? grant.principal_label} size="sm" />
          ) : (
            <EntityAvatar icon={UsersIcon} size="sm" />
          ),
      },
      current: {
        role: policy ? customRole(policy.role_id) : role === 'manager' || role === 'member' ? builtinRole(role) : ROLE_NONE,
        agentIds: agentIds.length > 0 ? agentIds : 'all',
        expiresAt: policy ? policy.expires_at : (member?.expires_at ?? null),
      },
      inheritedFrom:
        grant.principal_type === 'member'
          ? (member?.group_sources ?? []).map((g) => g.group_name)
          : undefined,
    });
    setEditOpen(true);
  };

  return (
    <EditorSection
      title={tI18nComplete.raw('text82d9af69e1a1')}
      description={tI18nComplete.raw('text96feb5be077d')}
    >
      <div className="space-y-3 py-3.5">
        {grantsQuery.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-11 w-full rounded-md" />
            <Skeleton className="h-11 w-full rounded-md" />
          </div>
        ) : assigned.length === 0 ? (
          <p className="text-muted-foreground text-xs text-pretty">
            {tI18nComplete.raw('text011c4e48df01')}
          </p>
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
                  ) : g.principal_type === 'project' ? (
                    <EntityAvatar icon={UsersThreeIcon} size="md" />
                  ) : (
                    <UserAvatar email={member?.email ?? g.principal_label} size="md" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="text-foreground block truncate text-sm font-medium">
                      {g.principal_type === 'project'
                        ? tSharing('everyone', { project: g.principal_label })
                        : g.principal_label}
                    </span>
                    <span className="text-muted-foreground block truncate text-xs">
                      {g.principal_type === 'project'
                        ? tSharing('everyoneMeta')
                        : g.principal_type === 'group'
                          ? tSharing('groupMeta')
                          : tSharing('memberMeta')}
                      {g.expires_at
                        ? tI18nComplete('textdc40ace03968', {
                            value0: new Date(g.expires_at).toLocaleDateString(),
                          })
                        : ''}
                      {g.orphaned ? tI18nComplete.raw('textc795f93da2e5') : ''}
                    </span>
                  </span>
                  {g.principal_type === 'project' ? (
                    <Button variant="ghost" size="sm" onClick={() => setStopSharing(g)}>
                      {tSharing('removeEveryone')}
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="gap-1.5"
                      onClick={() => openEdit(g)}
                      disabled={!accountId}
                    >
                      <PencilSimpleIcon className="size-3.5 shrink-0" />
                      {tI18nComplete.raw('text464c4ffd019e')}
                    </Button>
                  )}
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
            {tI18nComplete.raw('text8693768c7e08')}
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
          initialAgentIds={[agentName]}
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

      <ConfirmDialog
        open={stopSharing !== null}
        onOpenChange={(open) => !open && setStopSharing(null)}
        title={tSharing('removeEveryoneTitle', { agent: agentName })}
        description={tSharing('removeEveryoneDescription', { agent: agentName })}
        confirmLabel={tSharing('removeEveryone')}
        confirmVariant="destructive"
        isPending={stopSharingMutation.isPending}
        onConfirm={() => stopSharing && stopSharingMutation.mutate(stopSharing.grant_id)}
      />
    </EditorSection>
  );
}

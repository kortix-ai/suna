'use client';

/**
 * The agents that hold a role on one project — the "Agents" block of the
 * project access panel.
 *
 * Reverses the 2026-08-18 access-control-rehaul rule "agents are never
 * selectable principals in the UI" (spec 2026-09-22 agents as principals): an
 * agent is its service account, and a project role bound to it is the agent's
 * CEILING. The agent acts with its `kortix_permissions` (kortix.yaml) within
 * that role, minus the human-only permissions. An agent with no row here runs
 * under the built-in default ceiling.
 *
 * Admin-only, like roles: every read here asserts `policy.read`.
 */

import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import { errorToast, successToast } from '@/components/ui/toast';
import {
  AccessDialog,
  AccessList,
  AccessRow,
  builtinRole,
  customRole,
  formatExpiry,
  roleValueLabel,
  type KebabItem,
} from '@/features/workspace/shared/access';
import {
  useAgentIdentities,
  useProjectAgentAssignments,
} from '@/features/workspace/shared/access/agent-principals';
import { useTranslations } from '@/i18n/use-translations';
import { listRoles, revokeAssignment, type ProjectRole, type RoleAssignment } from '@kortix/sdk';
import { invalidatePermissionProbes } from '@kortix/sdk/react';
import { PencilSimpleIcon, RobotIcon, TrashIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

interface AgentRow {
  assignment: RoleAssignment;
  agentName: string;
}

export function ProjectAgentAccessList({
  accountId,
  projectId,
  projectName,
  rbacEnabled,
}: {
  accountId: string;
  projectId: string;
  projectName: string;
  rbacEnabled: boolean;
}) {
  const t = useTranslations('agentPrincipals');
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const queryClient = useQueryClient();
  const identitiesQuery = useAgentIdentities(accountId);
  const assignmentsQuery = useProjectAgentAssignments(accountId, projectId);
  const rolesQuery = useQuery({
    queryKey: ['iam-roles', accountId],
    queryFn: () => listRoles(accountId),
    staleTime: 30_000,
    retry: false,
  });

  const rows = useMemo<AgentRow[]>(() => {
    const byServiceAccount = new Map(
      (identitiesQuery.data ?? [])
        .filter((i) => i.project_id === projectId && i.agent_name)
        .map((i) => [i.service_account_id, i.agent_name as string]),
    );
    return (assignmentsQuery.data ?? [])
      .filter((a) => a.scope_type === 'project' && a.scope_id === projectId)
      .flatMap((assignment) => {
        const agentName = byServiceAccount.get(assignment.principal_id);
        return agentName ? [{ assignment, agentName }] : [];
      })
      .sort((a, b) => a.agentName.localeCompare(b.agentName));
  }, [identitiesQuery.data, assignmentsQuery.data, projectId]);

  const [editRow, setEditRow] = useState<AgentRow | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [removeRow, setRemoveRow] = useState<AgentRow | null>(null);

  function invalidate() {
    void invalidatePermissionProbes(queryClient, { accountId });
    queryClient.invalidateQueries({ queryKey: ['iam-assignments', accountId] });
  }

  const removeMutation = useMutation({
    mutationFn: (assignmentId: string) => revokeAssignment(accountId, assignmentId),
    onSuccess: () => {
      successToast(t('ceilingRemoved'));
      invalidate();
    },
    onError: (error: Error) => errorToast(error.message || t('ceilingRemoveFailed')),
  });

  // Nothing to say to a non-admin (the reads 403) or while nothing is bound.
  if (identitiesQuery.isError || assignmentsQuery.isError || rows.length === 0) return null;

  const roleNames = new Map((rolesQuery.data ?? []).map((r) => [r.role_id, r.name]));
  const roleLabel = (a: RoleAssignment) =>
    a.role_is_system
      ? roleValueLabel('project', builtinRole(a.role_key as ProjectRole), undefined, tI18nComplete)
      : (roleNames.get(a.role_id) ?? a.role_key);

  return (
    <>
      <AccessList header={{ title: t('agentsSection'), count: rows.length }}>
        {rows.map((row) => {
          const kebab: KebabItem[] = [
            {
              label: tI18nComplete.raw('texta514a684676a'),
              icon: <PencilSimpleIcon className="size-3.5" />,
              onSelect: () => {
                setEditRow(row);
                setEditOpen(true);
              },
            },
            {
              label: tI18nComplete.raw('textbb349bfe6750'),
              icon: <TrashIcon className="size-3.5" />,
              variant: 'destructive' as const,
              separated: true,
              onSelect: () => setRemoveRow(row),
            },
          ];
          return (
            <AccessRow
              key={row.assignment.assignment_id}
              leading={<EntityAvatar icon={RobotIcon} label={row.agentName} size="sm" />}
              title={<span data-testid="agent-access-row">{row.agentName}</span>}
              badges={
                <Badge variant="outline" size="sm">
                  {t('agentBadge')}
                </Badge>
              }
              metaParts={[
                <span key="ceiling">{t('rowMeta')}</span>,
                <span key="expires" className="tabular-nums">
                  {formatExpiry(row.assignment.expires_at, tI18nComplete).label}
                </span>,
              ]}
              trailing={roleLabel(row.assignment)}
              kebab={kebab}
              kebabLabel={tI18nComplete('text33da220b1a34', { value0: row.agentName })}
              pending={
                removeMutation.isPending &&
                removeMutation.variables === row.assignment.assignment_id
              }
            />
          );
        })}
      </AccessList>

      {editRow ? (
        <AccessDialog
          key={editRow.assignment.assignment_id}
          open={editOpen}
          onOpenChange={setEditOpen}
          accountId={accountId}
          scope={{ kind: 'project', projectId, projectName }}
          mode={{
            kind: 'edit',
            principal: {
              type: 'agent',
              id: editRow.assignment.principal_id,
              label: editRow.agentName,
            },
            current: {
              role: editRow.assignment.role_is_system
                ? builtinRole(editRow.assignment.role_key as ProjectRole)
                : customRole(editRow.assignment.role_id),
              expiresAt: editRow.assignment.expires_at,
              assignmentId: editRow.assignment.assignment_id,
            },
          }}
          rbacEnabled={rbacEnabled}
          canManageRoles
          onDone={invalidate}
        />
      ) : null}

      <ConfirmDialog
        open={removeRow !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveRow(null);
        }}
        title={t('removeCeilingTitle', { agent: removeRow?.agentName ?? '' })}
        description={t('removeCeilingDescription', { project: projectName })}
        confirmLabel={tI18nComplete.raw('textbb349bfe6750')}
        confirmVariant="destructive"
        isPending={removeMutation.isPending}
        onConfirm={() => {
          if (!removeRow) return;
          const target = removeRow;
          setRemoveRow(null);
          removeMutation.mutate(target.assignment.assignment_id);
        }}
      />
    </>
  );
}

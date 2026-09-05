'use client';

/**
 * The header's share control — who has this agent, and the way to give it
 * to someone else. Asana's shape (Marko, 2026-09-03): a stack of the
 * granted people's avatars, an overflow count, and a Share button.
 *
 * The avatars are a link to the People topic, where each grant can be edited;
 * Share opens the shared `AccessDialog` in grant mode with the agent picker
 * already narrowed to this agent, the same dialog the People topic's own
 * button opens. Both read the same `qk.project.resourceGrants` list, so a
 * grant made in the dialog shows up in the stack when the dialog closes.
 *
 * Gated on `project.members.manage`, the leaf the grants endpoint asserts;
 * a reader without it sees only Start session.
 */

import { Button } from '@/components/ui/button';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import Hint from '@/components/ui/hint';
import { UserAvatar } from '@/components/ui/user-avatar';
import { AccessDialog } from '@/features/workspace/shared/access/access-dialog';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import { cn } from '@/lib/utils';
import { getProjectDetail, listProjectResourceGrants } from '@kortix/sdk';
import { contract, qk, useProjectAccountId } from '@kortix/sdk/react';
import { ShareNetworkIcon, UsersIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useMemo, useState } from 'react';

import { grantsForAgent } from './agent-people-section';

/** How many avatars the stack shows before it folds the rest into "+N". */
const STACK_LIMIT = 4;

export function AgentShareControl({
  projectId,
  agentName,
  peopleHref,
}: {
  projectId: string;
  agentName: string;
  /** The People topic of this agent's page — where the stack links. */
  peopleHref: string;
}) {
  const canManage =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE).allowed === true;
  const accountId = useProjectAccountId(projectId);
  const [open, setOpen] = useState(false);

  const grantsQuery = useQuery({
    queryKey: qk.project.resourceGrants(projectId),
    queryFn: () => listProjectResourceGrants(projectId),
    enabled: canManage,
    retry: false,
    ...contract('inventory'),
  });
  const detailQuery = useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
    ...contract('config'),
  });
  const projectName = detailQuery.data?.project?.name ?? '';

  const assigned = useMemo(
    () => grantsForAgent(grantsQuery.data?.grants ?? [], agentName),
    [grantsQuery.data, agentName],
  );
  if (!canManage || !accountId) return null;

  const shown = assigned.slice(0, STACK_LIMIT);
  const rest = assigned.length - shown.length;
  const label =
    assigned.length === 0
      ? 'No one is granted this agent yet'
      : `${assigned.length} ${assigned.length === 1 ? 'grant' : 'grants'} — open People`;

  return (
    <div className="flex items-center gap-2">
      {assigned.length > 0 ? (
        <Hint label={label}>
          <Link
            href={peopleHref}
            prefetch
            aria-label={label}
            className={cn(
              'flex items-center rounded-full pl-1',
              'focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none',
            )}
          >
            {/* Overlapping stack: each bubble sits 6px into the one before,
                with a ring in the page background so the overlap reads as
                depth rather than a smear. */}
            {shown.map((g) => (
              <span
                key={g.grant_id}
                className="ring-background -ml-1.5 inline-flex rounded-full ring-2 first:ml-0"
              >
                {g.principal_type === 'group' ? (
                  <EntityAvatar icon={UsersIcon} size="sm" className="rounded-full" />
                ) : (
                  <UserAvatar email={g.principal_label} size="sm" />
                )}
              </span>
            ))}
            {rest > 0 ? (
              <span className="bg-muted text-muted-foreground ring-background -ml-1.5 inline-flex size-6 items-center justify-center rounded-full text-xs font-medium tabular-nums ring-2">
                +{rest}
              </span>
            ) : null}
          </Link>
        </Hint>
      ) : null}
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        <ShareNetworkIcon className="size-3.5 shrink-0" />
        Share
      </Button>

      <AccessDialog
        open={open}
        onOpenChange={setOpen}
        accountId={accountId}
        scope={{ kind: 'project', projectId, projectName }}
        mode={{ kind: 'grant' }}
        initialAgentIds={[agentName]}
      />
    </div>
  );
}

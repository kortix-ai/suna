'use client';

import { useTranslations as useI18nTranslations } from '@/i18n/use-translations';
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

import { AvatarGroup, AvatarGroupCount } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import { FadedScrollArea } from '@/components/ui/faded-scroll-area';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { UserAvatar } from '@/components/ui/user-avatar';
import { AccessDialog } from '@/features/workspace/shared/access/access-dialog';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import { cn } from '@/lib/utils';
import { getProjectDetail, listProjectResourceGrants } from '@kortix/sdk';
import { contract, qk, useProjectAccountId } from '@kortix/sdk/react';
import { ShareNetworkIcon, UsersIcon, UsersThreeIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useMemo, useState } from 'react';

import { grantsForAgent } from './agent-people-section';

type Grant = ReturnType<typeof grantsForAgent>[number];

/** A member's face, or the group / whole-project glyph, as a `rounded-sm` tile, never a circle. */
function GrantAvatar({ grant, size }: { grant: Grant; size: 'sm' | 'md' }) {
  if (grant.principal_type === 'group' || grant.principal_type === 'project') {
    return (
      <EntityAvatar
        icon={grant.principal_type === 'group' ? UsersIcon : UsersThreeIcon}
        size={size}
        className="ring-background ring-2"
      />
    );
  }
  return <UserAvatar email={grant.principal_label} size={size} />;
}

/** How many avatars the stack shows before it folds the rest into "+N". */
const STACK_LIMIT = 3;

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
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const canManage =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE).allowed === true;
  const accountId = useProjectAccountId(projectId);
  const [open, setOpen] = useState(false);
  const [stackOpen, setStackOpen] = useState(false);
  const tParticipants = useI18nTranslations('sessionParticipants');

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
        <HoverCard open={stackOpen} onOpenChange={setStackOpen} openDelay={300} closeDelay={100}>
          <HoverCardTrigger asChild>
            <Link
              href={peopleHref}
              prefetch
              aria-label={label}
              className={cn(
                'hover:bg-secondary flex h-7 items-center rounded-md p-0.5',
                'focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none',
              )}
            >
              {/* The session header's stack (`SessionParticipantStack`): the
                  same group, overlap, count tile and hover card. */}
              <AvatarGroup className="-space-x-1.5">
                {shown.map((g) => (
                  <GrantAvatar key={g.grant_id} grant={g} size="sm" />
                ))}
                {rest > 0 ? (
                  // `min-w-6 w-auto`: the tile grows with the count (+97), never under 24px.
                  <AvatarGroupCount className="h-6 w-auto min-w-6 px-1.5 text-xs tabular-nums">
                    +{rest}
                  </AvatarGroupCount>
                ) : null}
              </AvatarGroup>
            </Link>
          </HoverCardTrigger>
          <HoverCardContent
            side="bottom"
            align="end"
            sideOffset={6}
            animated={false}
            className="w-72 overflow-hidden p-0"
            onEscapeKeyDown={() => setStackOpen(false)}
          >
            <div className="text-muted-foreground flex items-center justify-between px-3.5 pt-2.5 pb-1 text-xs">
              <span>{tParticipants('title')}</span>
              <span className="tabular-nums">{assigned.length}</span>
            </div>
            <FadedScrollArea
              fadeColor="from-popover"
              fadeSize="6"
              className="max-h-64 overscroll-contain"
            >
              <ul className="p-1 pt-0">
                {assigned.map((g) => (
                  <li key={g.grant_id}>
                    <div className="text-foreground flex min-h-9 items-center gap-2.5 px-2 py-1 text-sm">
                      <GrantAvatar grant={g} size="md" />
                      <span className="min-w-0 flex-1 truncate leading-tight">
                        {g.principal_label}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </FadedScrollArea>
          </HoverCardContent>
        </HoverCard>
      ) : null}
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        <ShareNetworkIcon className="size-3.5 shrink-0" />
        {tI18nComplete.raw('text29887a5ff984')}
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

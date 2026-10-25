'use client';
import { useAgentGrants } from './use-agent-grants';

import { useTranslations as useI18nTranslations } from '../../i18n';
/**
 * The header's share control — who has this agent, and the way to give it
 * to someone else. Asana's shape (Marko, 2026-09-03): a stack of the
 * granted people's avatars, an overflow count, and a Share button.
 *
 * The avatars and Share open one dialog (`AgentShareDialog`): who may use
 * the agent, Edit on each grant, and Grant access. The page owns the
 * dialog's open state, so the Overview's People row and the old
 * `?tab=people` link open the same dialog. Both read the same
 * `qk.project.resourceGrants` list, so a grant made in the dialog shows up
 * in the stack at once.
 *
 * Gated on `project.members.manage`, the leaf the grants endpoint asserts;
 * a reader without it sees only Start session.
 */

import { AvatarGroup, AvatarGroupCount } from '../../primitives/avatar';
import { Button } from '../../primitives/button';
import { EntityAvatar } from '../../primitives/entity-avatar';
import { FadedScrollArea } from '../../primitives/faded-scroll-area';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../../primitives/hover-card';
import { UserAvatar } from '../../primitives/user-avatar';
import { PROJECT_ACTIONS } from '../../internal/lib/project-actions';
import { useProjectCan } from '../../internal/lib/use-project-can';
import { cn } from '../../internal/lib/utils';
import { useProjectAccountId } from '@kortix/sdk/react';
import { ShareNetworkIcon, UsersIcon, UsersThreeIcon } from '@phosphor-icons/react';
import { useMemo, useState } from 'react';

import { AgentShareDialog, grantsForAgent } from './agent-share-dialog';

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
  open,
  onOpenChange,
}: {
  projectId: string;
  agentName: string;
  /** The Share dialog, owned by the page. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const canManage =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE).allowed === true;
  const accountId = useProjectAccountId(projectId);
  const [stackOpen, setStackOpen] = useState(false);
  const tParticipants = useI18nTranslations('sessionParticipants');

  const grantsQuery = useAgentGrants(projectId, canManage);

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
      : `${assigned.length} ${assigned.length === 1 ? 'grant' : 'grants'} — open Share`;

  return (
    <div className="flex items-center gap-2">
      {assigned.length > 0 ? (
        <HoverCard open={stackOpen} onOpenChange={setStackOpen} openDelay={300} closeDelay={100}>
          <HoverCardTrigger asChild>
            <button
              type="button"
              onClick={() => onOpenChange(true)}
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
            </button>
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
      <Button variant="secondary" size="sm" onClick={() => onOpenChange(true)}>
        <ShareNetworkIcon className="size-3.5 shrink-0" />
        {tI18nComplete.raw('text29887a5ff984')}
      </Button>

      <AgentShareDialog projectId={projectId} agentName={agentName} open={open} onOpenChange={onOpenChange} />
    </div>
  );
}

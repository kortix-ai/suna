'use client';

import type { ProjectSpace } from '@kortix/sdk';
import { useUpdateProjectSpace } from '@kortix/sdk/react';

import { useTranslations } from '../../i18n';
import { Close } from '../../icons/close';
import { AgentMark } from '../../internal/components/agent-mark';
import { Button } from '../../primitives/button';
import { errorToast, successToast } from '../../primitives/toast';
import { agentLabel } from './space-timeline';

/**
 * Above a space's composer after a send named an agent from outside the space
 * (flag `chat`). A space's agents are a boundary: the router hands work only
 * to them, so naming another agent never adds it. A person who may edit the
 * channel gets "Add Worker to #launch? Add · Not now"; anyone else gets who to
 * ask. Add replaces the channel's agent list (PATCH space `agents`).
 */
export function SpaceAgentAsk({
  projectId,
  space,
  agent,
  onDone,
}: {
  projectId: string;
  space: ProjectSpace;
  agent: string;
  onDone: () => void;
}) {
  const t = useTranslations('spaces.mentions');
  const update = useUpdateProjectSpace(projectId);
  const spaceName = `#${space.slug ?? space.name}`;
  const label = agentLabel(agent);
  const canEdit = space.kind === 'channel' && space.can_edit === true;
  const add = () => {
    const agents = space.agents ?? [];
    if (agents.includes(agent)) return onDone();
    update.mutate(
      { spaceId: space.space_id, input: { agents: [...agents, agent] } },
      {
        onSuccess: () => {
          successToast(t('added', { agent: label, space: spaceName }));
          onDone();
        },
        onError: () => errorToast(t('addFailed')),
      },
    );
  };
  return (
    <div
      role="status"
      aria-live="polite"
      data-space-agent-ask={agent}
      className="bg-sidebar border-border flex w-full items-center gap-2 rounded-xl border py-1.5 pr-1.5 pl-3"
    >
      <AgentMark slug={agent} size={14} />
      <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
        {canEdit ? t('askAdd', { agent: label, space: spaceName }) : t('askAdmin', { agent: label, space: spaceName })}
      </span>
      {canEdit ? (
        <>
          <Button type="button" size="xs" onClick={add} disabled={update.isPending}>
            {t('askAddConfirm')}
          </Button>
          <Button type="button" variant="ghost" size="xs" className="text-muted-foreground hover:text-foreground" onClick={onDone}>
            {t('askNotNow')}
          </Button>
        </>
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground hover:text-foreground"
          aria-label={t('dismiss')}
          onClick={onDone}
        >
          <Close className="size-3.5" />
        </Button>
      )}
    </div>
  );
}

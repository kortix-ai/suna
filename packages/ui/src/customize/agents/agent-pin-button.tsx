'use client';

import { PushPinIcon, PushPinSlashIcon } from '@phosphor-icons/react';

import { useTranslations } from '../../i18n';
import { usePinnedAgents, usePinnedAgentsStore } from '../../internal/stores/pinned-agents-store';
import { cn } from '../../internal/lib/utils';
import { Button } from '../../primitives/button';
import Hint from '../../primitives/hint';

/**
 * Pins an agent to the sidebar's Customize, or unpins it: on the agent's
 * page header, and on its card in All agents. `onCard` shows it on the card's
 * hover only, and always once pinned so the state is visible.
 */
export function AgentPinButton({
  projectId,
  agent,
  onCard = false,
}: {
  projectId: string;
  agent: string;
  onCard?: boolean;
}) {
  const t = useTranslations('agentEditor.tabs');
  const pinned = usePinnedAgents(projectId).includes(agent);
  const togglePinned = usePinnedAgentsStore((state) => state.togglePinned);
  const label = pinned ? t('unpinFromSidebar') : t('pinToSidebar');
  return (
    <Hint side="top" label={label}>
      <Button
        type="button"
        variant="secondary"
        size={onCard ? 'icon-xs' : 'icon-base'}
        aria-label={label}
        aria-pressed={pinned}
        className={cn(
          'transition-opacity focus-visible:opacity-100',
          onCard && !pinned && 'md:opacity-0 md:group-hover/card:opacity-100',
        )}
        onClick={() => togglePinned(projectId, agent)}
      >
        {pinned ? <PushPinSlashIcon className="size-4" /> : <PushPinIcon className="size-4" />}
      </Button>
    </Hint>
  );
}

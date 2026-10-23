'use client';

import type { ProjectMemoryAuthor, ProjectMemoryPageType } from '@kortix/sdk';
import { BookOpenIcon, BriefcaseIcon, CheckIcon, type Icon, NoteIcon, UserIcon } from '@phosphor-icons/react';

import { useTranslations } from '../../i18n';
import { AgentAvatar, agentDisplayName } from '../../internal/agent-avatar';
import { UserAvatar } from '../../primitives/user-avatar';
import { participantLabel } from '../../session/participants/session-participants';

/** The left list's groups, in order. Notes show only when a layer has some. */
export const MEMORY_GROUPS: readonly ProjectMemoryPageType[] = ['people', 'decisions', 'workstreams', 'playbooks', 'note'];

export const MEMORY_TYPE_ICON: Record<ProjectMemoryPageType, Icon> = {
  people: UserIcon,
  decisions: CheckIcon,
  workstreams: BriefcaseIcon,
  playbooks: BookOpenIcon,
  note: NoteIcon,
};

/** Who wrote a change, as a name: the agent, the person, or "Kortix" for an import. */
export function useMemoryAuthorName(): (author: ProjectMemoryAuthor) => string {
  const t = useTranslations('spaces.memory');
  return (author) => {
    if (author.kind === 'agent' && author.agent) return agentDisplayName(author.agent);
    if (author.kind === 'person' && author.name) return participantLabel({ name: author.name, email: null });
    return author.kind === 'system' ? t('author.system') : t('author.unknown');
  };
}

/** The author's tile: an agent's own glyph, a person's initials. */
export function MemoryAuthorAvatar({ author, name }: { author: ProjectMemoryAuthor; name: string }) {
  if (author.kind === 'agent') return <AgentAvatar name={author.agent} label={name} size="xs" />;
  return <UserAvatar email={author.user_id ?? name} name={name} size="xs" />;
}

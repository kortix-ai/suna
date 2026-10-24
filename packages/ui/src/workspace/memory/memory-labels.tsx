'use client';

import type { ProjectMemoryAuthor, ProjectMemoryLayer, ProjectMemoryPageType } from '@kortix/sdk';
import { BookOpenIcon, BriefcaseIcon, FileTextIcon, type Icon, NoteIcon, SignpostIcon, UserIcon } from '@phosphor-icons/react';

import { useTranslations } from '../../i18n';
import { EntityAvatar } from '../../primitives/entity-avatar';
import { UserAvatar } from '../../primitives/user-avatar';
import { participantLabel } from '../../session/participants/session-participants';
import { agentLabel } from '../spaces/space-timeline';

export const MEMORY_TYPE_ICON: Record<ProjectMemoryPageType, Icon> = {
  people: UserIcon,
  decisions: SignpostIcon,
  workstreams: BriefcaseIcon,
  playbooks: BookOpenIcon,
  note: NoteIcon,
  other: FileTextIcon,
};

/** The layer's live pages, notes included: the Memory tab's count, the rows its list shows. */
export function memoryPageCount(counts: ProjectMemoryLayer['counts'] | undefined): number {
  return counts ? counts.people + counts.decisions + counts.workstreams + counts.playbooks + counts.note + counts.other : 0;
}

/** Who wrote a change, as a name: the agent, the person, or "Kortix" for an import. */
export function useMemoryAuthorName(): (author: ProjectMemoryAuthor) => string {
  const t = useTranslations('spaces.memory');
  return (author) => {
    if (author.kind === 'agent' && author.agent) return agentLabel(author.agent);
    if (author.kind === 'person' && author.name) return participantLabel({ name: author.name, email: null });
    return author.kind === 'system' ? t('author.system') : t('author.unknown');
  };
}

/** The author's tile: an agent's initial tile, a person's initials. */
export function MemoryAuthorAvatar({ author, name }: { author: ProjectMemoryAuthor; name: string }) {
  if (author.kind === 'agent') return <EntityAvatar label={name} size="xs" />;
  return <UserAvatar email={author.user_id ?? name} name={name} size="xs" />;
}

'use client';

import type { ProjectMemoryAuthor, ProjectMemoryPageType } from '@kortix/sdk';
import { BookOpenIcon, BriefcaseIcon, FileTextIcon, type Icon, NoteIcon, SignpostIcon, UserIcon } from '@phosphor-icons/react';

import { AgentMark } from '../../internal/components/agent-mark';
import { useTranslations } from '../../i18n';
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

/**
 * A named person or agent wrote the change. A file with no front-matter author
 * (a Remember note, a Drive sync) has none: the reader shows no "by …" and
 * History shows the change without an author, never an invented "A member".
 */
export function hasMemoryAuthor(author: ProjectMemoryAuthor): boolean {
  return author.kind === 'agent' ? !!author.agent : author.kind === 'person' && !!author.name;
}

/** Who wrote a change, as a name: the agent, the person (the app's `participantLabel` rule), or "Kortix" for an import. */
export function useMemoryAuthorName(): (author: ProjectMemoryAuthor) => string {
  const t = useTranslations('spaces.memory');
  return (author) => {
    if (author.kind === 'agent' && author.agent) return agentLabel(author.agent);
    if (author.kind === 'person' && author.name) return participantLabel({ name: author.name, email: null });
    if (author.kind === 'agent') return t('author.agent');
    return author.kind === 'system' ? t('author.system') : t('author.unknown');
  };
}

/** The author's tile: an agent's pixel mark, a person's initials, a page glyph when nobody is named. */
export function MemoryAuthorAvatar({ author, name }: { author: ProjectMemoryAuthor; name: string }) {
  if (author.kind === 'agent' && author.agent) return <AgentMark slug={author.agent} label={name} />;
  if (!hasMemoryAuthor(author)) {
    // Neutral, not `EntityAvatar`: its hashed pastel would read as a person.
    return (
      <span className="bg-muted text-muted-foreground flex size-5 shrink-0 items-center justify-center rounded-sm border">
        <FileTextIcon className="size-3" aria-hidden />
      </span>
    );
  }
  return <UserAvatar email={author.user_id ?? name} name={name} size="xs" />;
}

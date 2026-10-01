'use client';

import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { UserAvatar } from '@/components/ui/user-avatar';
import { askedFromParentId, sessionPeople } from '@/features/workspace/project-sidebar/asked-you';
import { getSessionDisplayTitle } from '@/features/workspace/project-sidebar/project-session-list-helpers';
import { useTranslations } from '@/i18n/use-translations';
import { getProjectSession, type ProjectSession } from '@kortix/sdk';
import { qk, useFeatureFlag } from '@kortix/sdk/react';
import { ArrowBendUpLeftIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';

const MAX_AVATARS = 3;

/**
 * Who is in a conversation with people (`human_messaging`): their avatars, the
 * names on hover. Renders nothing for an ordinary session or with the flag off.
 */
export function SessionPeopleIndicator({
  projectId,
  session,
}: {
  projectId: string;
  session: ProjectSession | null;
}) {
  const t = useTranslations('sidebar.askedYou');
  const { enabled } = useFeatureFlag(projectId, 'human_messaging');
  const people = session ? sessionPeople(session) : [];
  if (!enabled || people.length === 0) return null;
  const shown = people.slice(0, MAX_AVATARS);
  const extra = people.length - shown.length;
  return (
    <Hint side="bottom" label={`${t('inConversation')}: ${people.map((p) => p.label).join(', ')}`}>
      <span
        className="flex shrink-0 items-center -space-x-1.5"
        data-session-people="true"
        aria-label={people.map((p) => p.label).join(', ')}
      >
        {shown.map((p) => (
          <UserAvatar key={p.id} ring size="xs" name={p.label} email={p.email ?? ''} />
        ))}
        {extra > 0 && (
          <span className="bg-secondary text-muted-foreground ring-background flex size-5 items-center justify-center rounded-sm text-xs ring-2">
            +{extra}
          </span>
        )}
      </span>
    </Hint>
  );
}

/**
 * "Asked from <session>": a link back to the session that opened this
 * conversation, shown only when the viewer can open that session. A person asked
 * into a conversation usually cannot, and then sees nothing.
 */
export function SessionAskedFromLink({
  projectId,
  session,
}: {
  projectId: string;
  session: ProjectSession | null;
}) {
  const t = useTranslations('sidebar.askedYou');
  const { enabled } = useFeatureFlag(projectId, 'human_messaging');
  const parentId = session ? askedFromParentId(session) : null;
  const { data: parent } = useQuery({
    queryKey: qk.project.session(projectId, parentId ?? ''),
    // A 404 is the expected answer for a participant, so it must not toast.
    queryFn: () => getProjectSession(projectId, parentId as string, { showErrors: false }),
    enabled: enabled && parentId !== null,
    retry: false,
    staleTime: 30_000,
  });
  // A disabled query still serves a cached parent, so the flag gates the link too.
  if (!enabled || !parentId || !parent || parent.can_access === false) return null;
  return (
    <Button
      asChild
      variant="ghost"
      className="text-muted-foreground hover:text-foreground hidden h-7 min-w-0 shrink gap-1.5 rounded-md px-2 text-xs md:inline-flex"
    >
      <Link href={`/projects/${projectId}/sessions/${parentId}`} data-session-asked-from="true">
        <ArrowBendUpLeftIcon className="size-3.5 shrink-0" />
        <span className="max-w-48 truncate">
          {t('askedFrom', { title: getSessionDisplayTitle(parent) })}
        </span>
      </Link>
    </Button>
  );
}

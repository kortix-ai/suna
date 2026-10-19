'use client';

import { Button } from '@/components/ui/button';
import { CountBadge } from '@/components/ui/count-badge';
import { InlineMeta } from '@/components/ui/inline-meta';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { CapabilityPageShell } from '@/features/workspace/capabilities/shared/capability-page-shell';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { useTranslations } from '@/i18n/use-translations';
import type { Room, RoomConversation } from '@kortix/sdk';
import { useRoomConversations, useRooms } from '@kortix/sdk/react';
import { PencilSimpleIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { useMemo, useState } from 'react';

import { NewMessageModal } from './new-message-modal';
import { ConversationAvatar, conversationTitle } from './room-identity';

/**
 * /projects/[id]/rooms — the caller's conversations (rooms and direct ones,
 * newest first, with unread counts), then the named rooms they are not in.
 */
export function RoomsPage({ projectId }: { projectId: string }) {
  const t = useTranslations('rooms');
  const conversations = useRoomConversations(projectId);
  const rooms = useRooms(projectId);
  const [composing, setComposing] = useState(false);

  const mine = useMemo(
    () =>
      [...(conversations.data ?? [])].sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
    [conversations.data],
  );
  const others = useMemo(() => {
    const joined = new Set(mine.map((c) => c.room_id));
    return (rooms.data ?? []).filter((room) => !joined.has(room.room_id));
  }, [rooms.data, mine]);

  return (
    <CapabilityPageShell
      title={t('title')}
      description={t('description')}
      action={
        <Button size="sm" onClick={() => setComposing(true)}>
          <PencilSimpleIcon />
          {t('newMessage')}
        </Button>
      }
    >
      {conversations.isError ? (
        <ErrorState
          size="sm"
          title={t('loadError')}
          action={
            <Button size="sm" variant="outline" onClick={() => conversations.refetch()}>
              {t('retry')}
            </Button>
          }
        />
      ) : conversations.isLoading ? (
        <RowSkeletons />
      ) : mine.length === 0 && others.length === 0 ? (
        <EmptyState size="sm" title={t('empty')} description={t('emptyHint')} />
      ) : (
        <div className="space-y-8">
          {mine.length > 0 ? (
            <section className="space-y-4">
              <Label>{t('conversations')}</Label>
              <ul className="space-y-2">
                {mine.map((conversation) => (
                  <ConversationRow
                    key={conversation.room_id}
                    projectId={projectId}
                    conversation={conversation}
                  />
                ))}
              </ul>
            </section>
          ) : null}
          {others.length > 0 ? (
            <section className="space-y-4">
              <Label>{t('rooms')}</Label>
              <ul className="space-y-2">
                {others.map((room) => (
                  <ConversationRow key={room.room_id} projectId={projectId} conversation={room} />
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      )}
      <NewMessageModal projectId={projectId} open={composing} onOpenChange={setComposing} />
    </CapabilityPageShell>
  );
}

function ConversationRow({
  projectId,
  conversation,
}: {
  projectId: string;
  conversation: Room | RoomConversation;
}) {
  const t = useTranslations('rooms');
  const unread = 'unread' in conversation ? conversation.unread : 0;
  const peer = 'peer' in conversation ? conversation.peer : null;
  return (
    <li>
      <Link
        href={`/projects/${projectId}/rooms/${conversation.room_id}`}
        className="bg-popover hover:bg-foreground/5 flex items-center gap-3 rounded-md border px-4 py-2.5 transition-colors"
      >
        <ConversationAvatar kind={conversation.kind} name={conversation.name} peer={peer} />
        <div className="min-w-0 flex-1">
          <div className="text-foreground truncate text-sm font-medium">
            {conversationTitle(conversation.name, peer, t('direct'))}
          </div>
          <InlineMeta>
            {conversation.kind === 'direct' ? t('direct') : null}
            {conversation.topic}
            {conversation.member_count
              ? t('memberCount', { count: conversation.member_count })
              : null}
          </InlineMeta>
        </div>
        {unread > 0 ? <CountBadge count={unread} tone="waiting" /> : null}
      </Link>
    </li>
  );
}

function RowSkeletons() {
  return (
    <ul className="space-y-2">
      {[0, 1, 2].map((i) => (
        <li key={i}>
          <Skeleton className="h-14 w-full rounded-md" />
        </li>
      ))}
    </ul>
  );
}

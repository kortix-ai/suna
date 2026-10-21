'use client';

import { EmptyState } from '@kortix/ui/empty-state';
import { useTranslations } from '@/i18n/use-translations';
import { useRoomConversations } from '@kortix/sdk/react';

/**
 * /projects/[id]/rooms — the room pane with nothing open. The list beside it
 * carries "Add rooms", so this pane only says what to do.
 */
export function RoomsPage({ projectId }: { projectId: string }) {
  const t = useTranslations('rooms');
  const conversations = useRoomConversations(projectId);
  if (!conversations.isSuccess) return null;
  const none = conversations.data.length === 0;

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-4 py-8">
      {none ? (
        <EmptyState size="sm" title={t('empty')} description={t('emptyHint')} />
      ) : (
        <EmptyState size="sm" title={t('pickRoom')} />
      )}
    </div>
  );
}

'use client';

import {
  InputGroupSearch,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import Loading from '@/components/ui/loading';
import { Modal, ModalBody, ModalContent, ModalDescription, ModalHeader, ModalTitle } from '@/components/ui/modal';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast } from '@/components/ui/toast';
import { UserAvatar } from '@/components/ui/user-avatar';
import { useTranslations } from '@/i18n/use-translations';
import { listRoomPeople, type RoomPerson } from '@kortix/sdk';
import { qk, useRoomConversations } from '@kortix/sdk/react';
import { MagnifyingGlassIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useDeferredValue, useState } from 'react';

/**
 * "New message": search the people the caller may message, pick one, and land
 * in the direct conversation with them (created on first use).
 */
export function NewMessageModal({
  projectId,
  open,
  onOpenChange,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('rooms');
  const router = useRouter();
  const [query, setQuery] = useState('');
  const q = useDeferredValue(query.trim());
  const { openDirect } = useRoomConversations(projectId);
  const people = useQuery({
    queryKey: [...qk.project.rooms(projectId), 'people', q],
    queryFn: async () => (await listRoomPeople(projectId, q || undefined)).people,
    enabled: open,
    staleTime: 30_000,
  });
  const [pendingId, setPendingId] = useState<string | null>(null);

  const start = async (person: RoomPerson) => {
    setPendingId(person.user_id);
    try {
      const conversation = await openDirect.mutateAsync({ user_id: person.user_id });
      onOpenChange(false);
      setQuery('');
      router.push(`/projects/${projectId}/rooms/${conversation.room_id}`);
    } catch (error) {
      errorToast(error instanceof Error ? error.message : t('openFailed'));
    } finally {
      setPendingId(null);
    }
  };

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="lg:max-w-lg">
        <ModalHeader>
          <ModalTitle>{t('newMessage')}</ModalTitle>
          <ModalDescription>{t('newMessageDescription')}</ModalDescription>
        </ModalHeader>
        <ModalBody className="space-y-4 pt-4">
          <InputGroupSearch>
            <InputGroupSearchIcon>
              <MagnifyingGlassIcon />
            </InputGroupSearchIcon>
            <InputGroupSearchInput
              size="sm"
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('searchPeople')}
              aria-label={t('searchPeople')}
            />
          </InputGroupSearch>
          <div className="max-h-80 overflow-y-auto">
            {people.isLoading ? (
              <div className="space-y-2">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-10 w-full rounded-md" />
                ))}
              </div>
            ) : people.isError ? (
              <p className="text-muted-foreground py-4 text-center text-sm">{t('peopleLoadError')}</p>
            ) : (people.data ?? []).length === 0 ? (
              <p className="text-muted-foreground py-4 text-center text-sm">{t('noPeople')}</p>
            ) : (
              <ul className="space-y-1">
                {(people.data ?? []).map((person) => (
                  <li key={person.user_id}>
                    <button
                      type="button"
                      disabled={pendingId !== null}
                      onClick={() => void start(person)}
                      className="hover:bg-foreground/5 focus-visible:ring-ring flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:opacity-50"
                    >
                      <UserAvatar email={person.email ?? person.user_id} name={person.name} size="sm" />
                      <span className="min-w-0 flex-1">
                        <span className="text-foreground block truncate text-sm">
                          {person.name ?? person.email ?? person.user_id}
                        </span>
                        {person.name && person.email ? (
                          <span className="text-muted-foreground block truncate text-xs">{person.email}</span>
                        ) : null}
                      </span>
                      {pendingId === person.user_id ? <Loading className="size-4 shrink-0" /> : null}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}

'use client';

import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupSearch,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import { InlineMeta } from '@/components/ui/inline-meta';
import Loading from '@/components/ui/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast } from '@/components/ui/toast';
import { useTranslations } from '@/i18n/use-translations';
import { createRoom } from '@kortix/sdk';
import { qk, useRooms } from '@kortix/sdk/react';
import { HashIcon, MagnifyingGlassIcon } from '@phosphor-icons/react';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useDeferredValue, useState, type FormEvent } from 'react';

import { ROOM_NAME_RE } from './room-text';

/** Create a channel (a named room) and open it. An existing name opens that room. */
export function CreateChannelModal({
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
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [pending, setPending] = useState(false);
  const valid = ROOM_NAME_RE.test(name);

  const close = (next: boolean) => {
    onOpenChange(next);
    if (!next) {
      setName('');
      setTopic('');
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid || pending) return;
    setPending(true);
    try {
      // The server adds the creator as the first member.
      const room = await createRoom(projectId, { name, topic: topic.trim() || null });
      await queryClient.invalidateQueries({ queryKey: qk.project.rooms(projectId) });
      close(false);
      router.push(`/projects/${projectId}/rooms/${room.room_id}`);
    } catch (error) {
      errorToast(error instanceof Error ? error.message : t('createFailed'));
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal open={open} onOpenChange={close}>
      <ModalContent className="lg:max-w-lg">
        <ModalHeader>
          <ModalTitle>{t('createChannel')}</ModalTitle>
          <ModalDescription>{t('createChannelDescription')}</ModalDescription>
        </ModalHeader>
        <form onSubmit={(event) => void submit(event)}>
          <ModalBody className="pt-4">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="room-name">{t('channelName')}</FieldLabel>
                <InputGroup>
                  <InputGroupAddon>
                    <HashIcon />
                  </InputGroupAddon>
                  <InputGroupInput
                    id="room-name"
                    autoFocus
                    value={name}
                    onChange={(event) => setName(event.target.value.toLowerCase().replace(/\s+/g, '-'))}
                    placeholder={t('channelNamePlaceholder')}
                    aria-invalid={name.length > 0 && !valid}
                    maxLength={64}
                    autoComplete="off"
                  />
                </InputGroup>
                <FieldDescription>{t('channelNameHint')}</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="room-topic">{t('topicOptional')}</FieldLabel>
                <Input
                  id="room-topic"
                  value={topic}
                  onChange={(event) => setTopic(event.target.value)}
                  placeholder={t('topicPlaceholder')}
                  maxLength={500}
                />
              </Field>
            </FieldGroup>
          </ModalBody>
          <ModalFooter className="sm:justify-between">
            <Button type="button" variant="outline-ghost" onClick={() => close(false)}>
              {t('cancel')}
            </Button>
            <Button type="submit" disabled={!valid || pending} aria-busy={pending}>
              {pending ? <Loading className="size-4 shrink-0" /> : null}
              {t('createChannel')}
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}

/** Every channel of the project, joined or not; a row opens it. */
export function BrowseChannelsModal({
  projectId,
  joined,
  open,
  onOpenChange,
}: {
  projectId: string;
  joined: ReadonlySet<string>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('rooms');
  const rooms = useRooms(open ? projectId : null);
  const [query, setQuery] = useState('');
  const q = useDeferredValue(query.trim().toLowerCase());
  const list = (rooms.data ?? [])
    .filter((room) => !room.archived_at)
    .filter((room) => !q || room.name?.includes(q) || room.topic?.toLowerCase().includes(q))
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="lg:max-w-lg">
        <ModalHeader>
          <ModalTitle>{t('browseChannels')}</ModalTitle>
          <ModalDescription>{t('browseChannelsDescription')}</ModalDescription>
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
              placeholder={t('searchChannels')}
              aria-label={t('searchChannels')}
            />
          </InputGroupSearch>
          <div className="max-h-80 overflow-y-auto">
            {rooms.isLoading ? (
              <div className="space-y-1">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-12 w-full rounded-md" />
                ))}
              </div>
            ) : rooms.isError ? (
              <p className="text-muted-foreground px-3 py-6 text-center text-xs">{t('loadError')}</p>
            ) : list.length === 0 ? (
              <p className="text-muted-foreground px-3 py-6 text-center text-xs">{t('noChannels')}</p>
            ) : (
              <ul className="divide-border divide-y">
                {list.map((room) => (
                  <li key={room.room_id}>
                    <Link
                      href={`/projects/${projectId}/rooms/${room.room_id}`}
                      onClick={() => onOpenChange(false)}
                      className="hover:bg-hover flex w-full items-start gap-2 rounded-md px-2 py-2 text-left"
                    >
                      <HashIcon className="text-muted-foreground mt-0.5 size-4 shrink-0" />
                      <span className="min-w-0 flex-1 space-y-0.5">
                        <span className="text-foreground block truncate text-sm font-medium">{room.name}</span>
                        <InlineMeta>
                          {joined.has(room.room_id) ? t('joined') : null}
                          {room.member_count !== undefined ? t('memberCount', { count: room.member_count }) : null}
                          {room.topic}
                        </InlineMeta>
                      </span>
                    </Link>
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

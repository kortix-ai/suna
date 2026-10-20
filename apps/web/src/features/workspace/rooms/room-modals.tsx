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
import { useAuth } from '@/features/providers/auth-provider';
import { useTranslations } from '@/i18n/use-translations';
import { addRoomPerson, createRoom, type Room } from '@kortix/sdk';
import { qk, useRooms } from '@kortix/sdk/react';
import { HashIcon, MagnifyingGlassIcon, PlusIcon } from '@phosphor-icons/react';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useDeferredValue, useState, type FormEvent } from 'react';

import { ROOM_NAME_RE } from './room-text';

/**
 * The one "Add rooms" surface (Slack's "Browse channels"): every room of the
 * project with search, each row "# name · topic · N members" plus Join or
 * Open, and "Create room", which turns the same dialog into the create form.
 */
export function RoomsDialog({
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
  const [mode, setMode] = useState<'browse' | 'create'>('browse');
  const close = (next: boolean) => {
    onOpenChange(next);
    if (!next) setMode('browse');
  };
  return (
    <Modal open={open} onOpenChange={close}>
      <ModalContent className="lg:max-w-lg">
        {mode === 'browse' ? (
          <BrowseRooms projectId={projectId} joined={joined} onCreate={() => setMode('create')} onDone={() => close(false)} />
        ) : (
          <CreateRoom projectId={projectId} onBack={() => setMode('browse')} onDone={() => close(false)} />
        )}
      </ModalContent>
    </Modal>
  );
}

function BrowseRooms({
  projectId,
  joined,
  onCreate,
  onDone,
}: {
  projectId: string;
  joined: ReadonlySet<string>;
  onCreate: () => void;
  onDone: () => void;
}) {
  const t = useTranslations('rooms');
  const rooms = useRooms(projectId);
  const [query, setQuery] = useState('');
  const q = useDeferredValue(query.trim().toLowerCase());
  const list = (rooms.data ?? [])
    .filter((room) => !room.archived_at)
    .filter((room) => !q || room.name.includes(q) || room.topic?.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <>
      <ModalHeader>
        <ModalTitle>{t('title')}</ModalTitle>
        <ModalDescription>{t('browseRoomsDescription')}</ModalDescription>
      </ModalHeader>
      <ModalBody className="space-y-4 pt-4">
        <div className="flex items-center gap-2">
          <InputGroupSearch className="min-w-0 flex-1">
            <InputGroupSearchIcon>
              <MagnifyingGlassIcon />
            </InputGroupSearchIcon>
            <InputGroupSearchInput
              size="sm"
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('searchRooms')}
              aria-label={t('searchRooms')}
            />
          </InputGroupSearch>
          <Button size="sm" variant="secondary" className="shrink-0 gap-1.5" onClick={onCreate}>
            <PlusIcon className="size-4" />
            {t('createRoom')}
          </Button>
        </div>
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
            <p className="text-muted-foreground px-3 py-6 text-center text-xs">{t('noRooms')}</p>
          ) : (
            <ul className="divide-border divide-y">
              {list.map((room) => (
                <BrowseRow key={room.room_id} projectId={projectId} room={room} joined={joined.has(room.room_id)} onDone={onDone} />
              ))}
            </ul>
          )}
        </div>
      </ModalBody>
    </>
  );
}

function BrowseRow({
  projectId,
  room,
  joined,
  onDone,
}: {
  projectId: string;
  room: Room;
  joined: boolean;
  onDone: () => void;
}) {
  const t = useTranslations('rooms');
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const [pending, setPending] = useState(false);
  const href = `/projects/${projectId}/rooms/${room.room_id}`;

  const join = async () => {
    if (!user) return;
    setPending(true);
    try {
      await addRoomPerson(projectId, room.room_id, user.id);
      await queryClient.invalidateQueries({ queryKey: qk.project.rooms(projectId) });
      onDone();
      router.push(href);
    } catch (error) {
      errorToast(error instanceof Error ? error.message : t('joinFailed'));
    } finally {
      setPending(false);
    }
  };

  return (
    <li className="flex items-center gap-3 py-2">
      <div className="flex min-w-0 flex-1 items-start gap-2 px-2 py-1">
        <HashIcon className="text-muted-foreground mt-0.5 size-4 shrink-0" />
        <span className="min-w-0 flex-1 space-y-0.5">
          <span className="text-foreground block truncate text-sm font-medium">{room.name}</span>
          <InlineMeta>
            {joined ? t('joined') : null}
            {room.member_count !== undefined ? t('memberCount', { count: room.member_count }) : null}
            {room.topic}
          </InlineMeta>
        </span>
      </div>
      {joined ? (
        <Button asChild size="sm" variant="outline" className="shrink-0">
          <Link href={href} onClick={onDone}>
            {t('openRoom')}
          </Link>
        </Button>
      ) : (
        <Button size="sm" className="shrink-0" disabled={pending} aria-busy={pending} onClick={() => void join()}>
          {t('join')}
        </Button>
      )}
    </li>
  );
}

/** The create form; the server adds the creator as the first member. An existing name opens that room. */
function CreateRoom({ projectId, onBack, onDone }: { projectId: string; onBack: () => void; onDone: () => void }) {
  const t = useTranslations('rooms');
  const router = useRouter();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [pending, setPending] = useState(false);
  const valid = ROOM_NAME_RE.test(name);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid || pending) return;
    setPending(true);
    try {
      const room = await createRoom(projectId, { name, topic: topic.trim() || null });
      await queryClient.invalidateQueries({ queryKey: qk.project.rooms(projectId) });
      onDone();
      router.push(`/projects/${projectId}/rooms/${room.room_id}`);
    } catch (error) {
      errorToast(error instanceof Error ? error.message : t('createFailed'));
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <ModalHeader>
        <ModalTitle>{t('createRoom')}</ModalTitle>
        <ModalDescription>{t('createRoomDescription')}</ModalDescription>
      </ModalHeader>
      <form onSubmit={(event) => void submit(event)}>
        <ModalBody className="pt-4">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="room-name">{t('roomName')}</FieldLabel>
              <InputGroup>
                <InputGroupAddon>
                  <HashIcon />
                </InputGroupAddon>
                <InputGroupInput
                  id="room-name"
                  autoFocus
                  value={name}
                  onChange={(event) => setName(event.target.value.toLowerCase().replace(/\s+/g, '-'))}
                  placeholder={t('roomNamePlaceholder')}
                  aria-invalid={name.length > 0 && !valid}
                  maxLength={64}
                  autoComplete="off"
                />
              </InputGroup>
              <FieldDescription>{t('roomNameHint')}</FieldDescription>
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
          <Button type="button" variant="outline-ghost" onClick={onBack}>
            {t('cancel')}
          </Button>
          <Button type="submit" disabled={!valid || pending} aria-busy={pending}>
            {pending ? <Loading className="size-4 shrink-0" /> : null}
            {t('createRoom')}
          </Button>
        </ModalFooter>
      </form>
    </>
  );
}

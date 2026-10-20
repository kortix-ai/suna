'use client';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import Hint from '@/components/ui/hint';
import { Label } from '@/components/ui/label';
import { Modal, ModalBody, ModalContent, ModalDescription, ModalHeader, ModalTitle } from '@/components/ui/modal';
import { errorToast, successToast } from '@/components/ui/toast';
import { AccessRow } from '@/features/workspace/shared/access/access-row';
import { useTranslations } from '@/i18n/use-translations';
import { addRoomPerson, addRoomSession, removeRoomPerson, removeRoomSession, type RoomMember } from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';
import { UserPlusIcon, XIcon } from '@phosphor-icons/react';
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import { PrincipalPicker, type PickedPrincipal } from './principal-picker';
import { ParticipantAvatar, StatusDot, sessionStatusKey } from './room-identity';
import { sessionDisplay } from './room-text';

/**
 * The room's members beside the messages: people, then agent sessions
 * (each opens its session). A member of the room adds and removes members
 * here; a viewer who has not joined lists them only.
 */
export function RoomMembersPanel({
  projectId,
  roomId,
  members,
  editable,
  viewerId,
  onClose,
}: {
  projectId: string;
  roomId: string;
  members: RoomMember[];
  /** The viewer is in the room: add and remove show. */
  editable: boolean;
  viewerId: string | null;
  onClose: () => void;
}) {
  const t = useTranslations('rooms');
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [removing, setRemoving] = useState<RoomMember | null>(null);
  const people = members.filter((m) => m.kind === 'person');
  const agents = members.filter((m) => m.kind === 'session');
  const memberIds = useMemo(
    () => new Set(members.flatMap((m) => (m.kind === 'session' ? m.session_id : m.user_id) ?? [])),
    [members],
  );

  const refresh = () => queryClient.invalidateQueries({ queryKey: qk.project.rooms(projectId) });

  const add = async (pick: PickedPrincipal) => {
    const id = pick.kind === 'person' ? pick.user_id : pick.session_id;
    setPendingId(id);
    try {
      if (pick.kind === 'person') await addRoomPerson(projectId, roomId, pick.user_id);
      else await addRoomSession(projectId, roomId, pick.session_id);
      await refresh();
      setAdding(false);
      successToast(t('memberAdded', { name: pick.label }));
    } catch (error) {
      errorToast(error instanceof Error ? error.message : t('addFailed'));
    } finally {
      setPendingId(null);
    }
  };

  const remove = async (member: RoomMember) => {
    setPendingId(member.member_id);
    try {
      if (member.kind === 'person' && member.user_id) await removeRoomPerson(projectId, roomId, member.user_id);
      else if (member.session_id) await removeRoomSession(projectId, roomId, member.session_id);
      await refresh();
      setRemoving(null);
      successToast(t('memberRemoved'));
    } catch (error) {
      errorToast(error instanceof Error ? error.message : t('removeFailed'));
    } finally {
      setPendingId(null);
    }
  };

  const nameOf = (m: RoomMember) => (m.kind === 'session' ? sessionDisplay(m.label).name : m.label);

  const row = (m: RoomMember) => {
    const isAgent = m.kind === 'session';
    const display = isAgent ? sessionDisplay(m.label) : null;
    const name = nameOf(m);
    return (
      <AccessRow
        key={m.member_id}
        leading={<ParticipantAvatar kind={m.kind} label={m.label} userId={m.user_id} size="md" />}
        title={m.user_id === viewerId && !isAgent ? t('you', { name }) : name}
        meta={
          isAgent ? (
            <span className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
              <StatusDot status={m.status} />
              <span className="truncate">{[t(sessionStatusKey(m.status)), display?.detail].filter(Boolean).join(' · ')}</span>
            </span>
          ) : undefined
        }
        href={isAgent && m.session_id ? `/projects/${projectId}/sessions/${m.session_id}` : undefined}
        pending={pendingId === m.member_id}
        kebabLabel={t('memberActions', { name })}
        kebab={
          editable
            ? [
                {
                  label: m.user_id === viewerId && !isAgent ? t('leaveRoom') : t('remove'),
                  variant: 'destructive' as const,
                  onSelect: () => setRemoving(m),
                },
              ]
            : undefined
        }
      />
    );
  };

  return (
    <aside
      aria-label={t('members')}
      className="bg-background border-border absolute inset-0 z-20 flex min-h-0 flex-col @5xl:static @5xl:w-80 @5xl:shrink-0 @5xl:border-l"
    >
      <header className="kx-titlebar-row border-border relative flex shrink-0 items-center gap-1 border-b px-2">
        <div className="kx-titlebar-tabs flex h-10 min-w-0 flex-1 items-center gap-2 pl-2">
          <h2 className="text-foreground min-w-0 flex-1 truncate text-sm font-semibold">
            {t('memberCount', { count: members.length })}
          </h2>
          <Hint label={t('closeMembers')} side="bottom">
            <Button variant="ghost" size="icon-sm" aria-label={t('closeMembers')} onClick={onClose}>
              <XIcon />
            </Button>
          </Hint>
        </div>
      </header>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
        {editable ? (
          <Button size="sm" variant="secondary" className="w-full gap-1.5" onClick={() => setAdding(true)}>
            <UserPlusIcon className="size-4" />
            {t('addMembers')}
          </Button>
        ) : null}
        {people.length > 0 ? (
          <section className="space-y-2">
            <Label>{t('people')}</Label>
            <ul className="space-y-2">{people.map(row)}</ul>
          </section>
        ) : null}
        {agents.length > 0 ? (
          <section className="space-y-2">
            <Label>{t('agents')}</Label>
            <ul className="space-y-2">{agents.map(row)}</ul>
          </section>
        ) : null}
      </div>

      <Modal open={adding} onOpenChange={setAdding}>
        <ModalContent className="lg:max-w-lg">
          <ModalHeader>
            <ModalTitle>{t('addMembers')}</ModalTitle>
            <ModalDescription>{t('addMembersDescription')}</ModalDescription>
          </ModalHeader>
          <ModalBody className="pt-4">
            {adding ? (
              <PrincipalPicker
                projectId={projectId}
                viewerId={viewerId}
                exclude={memberIds}
                pendingId={pendingId}
                onPick={(pick) => void add(pick)}
              />
            ) : null}
          </ModalBody>
        </ModalContent>
      </Modal>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={removing ? t('removeTitle', { name: nameOf(removing) }) : ''}
        description={removing?.kind === 'session' ? t('removeAgentDescription') : t('removePersonDescription')}
        confirmLabel={t('remove')}
        confirmVariant="destructive"
        isPending={removing !== null && pendingId === removing.member_id}
        onConfirm={() => removing && void remove(removing)}
      />
    </aside>
  );
}

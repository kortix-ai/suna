'use client';

import type { PrivateChannelSummary, ProjectSpace } from '@kortix/sdk';
import { usePrivateChannelsNotIn, useUpdateProjectSpace } from '@kortix/sdk/react';
import { DotsThreeIcon, LockSimpleIcon } from '@phosphor-icons/react';
import { useState } from 'react';

import { useTranslations } from '../../i18n';
import { PROJECT_ACTIONS } from '../../internal/lib/project-actions';
import { useProjectCan } from '../../internal/lib/use-project-can';
import { Badge } from '../../primitives/badge';
import { Button } from '../../primitives/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../../primitives/dropdown-menu';
import { Modal, ModalBody, ModalContent, ModalDescription, ModalHeader, ModalTitle } from '../../primitives/modal';
import { SidebarMenuButton, SidebarMenuItem } from '../../primitives/sidebar';
import { errorToast, successToast } from '../../primitives/toast';
import { CreateChannelDialog } from './create-channel-dialog';
import { AddChannelMembersDialog } from './space-members';

/**
 * The channel as the rename and add-people dialogs read it. A manager outside
 * it is not a member and may not edit its agents or description (D1).
 */
function asSpace(channel: PrivateChannelSummary): ProjectSpace {
  return {
    space_id: channel.space_id,
    kind: 'channel',
    slug: channel.slug,
    name: channel.name,
    description: null,
    is_default: false,
    dm_agent_name: null,
    archived_at: channel.archived_at,
    created_at: channel.created_at,
    updated_at: channel.created_at,
    can_edit: false,
    agents: [],
    is_member: false,
    visibility: 'private',
  };
}

/**
 * Project managers only: a quiet sidebar row under Channels that opens the
 * private channels they are not in (owner decision D1). They rename, archive
 * and add people there, never read the channel. A channel its last member left
 * is recovered here. Hidden for everyone else and when there is none.
 */
export function PrivateChannelsNotInRow({ projectId }: { projectId: string }) {
  const t = useTranslations('spaces.privateNotIn');
  const manager = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE).allowed === true;
  const list = usePrivateChannelsNotIn(projectId, { enabled: manager });
  const [open, setOpen] = useState(false);
  const channels = list.data ?? [];
  if (!manager || channels.length === 0) return null;
  return (
    <>
      <SidebarMenuItem>
        <SidebarMenuButton onClick={() => setOpen(true)} className="text-muted-foreground hover:text-sidebar-foreground">
          <LockSimpleIcon />
          <span className="truncate">{t('row')}</span>
          <span className="ml-auto text-xs tabular-nums">{channels.length}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
      <Modal open={open} onOpenChange={setOpen}>
        <ModalContent className="lg:max-w-md">
          <ModalHeader>
            <ModalTitle>{t('title')}</ModalTitle>
            <ModalDescription>{t('description')}</ModalDescription>
          </ModalHeader>
          <ModalBody className="space-y-px">
            {channels.map((channel) => (
              <PrivateChannelRow key={channel.space_id} projectId={projectId} channel={channel} />
            ))}
          </ModalBody>
        </ModalContent>
      </Modal>
    </>
  );
}

function PrivateChannelRow({ projectId, channel }: { projectId: string; channel: PrivateChannelSummary }) {
  const t = useTranslations('spaces.privateNotIn');
  const update = useUpdateProjectSpace(projectId);
  const [renaming, setRenaming] = useState(false);
  const [adding, setAdding] = useState(false);
  const space = asSpace(channel);
  const archived = channel.archived_at !== null;
  const setArchived = (next: boolean) =>
    update.mutate(
      { spaceId: channel.space_id, input: { archived: next } },
      {
        onSuccess: () => successToast(t(next ? 'archivedToast' : 'unarchivedToast', { name: channel.slug })),
        onError: () => errorToast(t('failed', { name: channel.slug })),
      },
    );
  return (
    <div className="flex items-center gap-3 rounded-md px-2 py-2">
      <LockSimpleIcon className="text-muted-foreground size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{channel.slug}</span>
          {archived ? <Badge variant="secondary">{t('archived')}</Badge> : null}
        </div>
        <p className="text-muted-foreground truncate text-xs">
          {channel.created_by_name
            ? t('meta', { count: channel.member_count, name: channel.created_by_name })
            : t('metaNoCreator', { count: channel.member_count })}
        </p>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground shrink-0"
            aria-label={t('menu', { name: channel.slug })}
            disabled={update.isPending}
          >
            <DotsThreeIcon className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {archived ? null : <DropdownMenuItem onSelect={() => setAdding(true)}>{t('addPeople')}</DropdownMenuItem>}
          <DropdownMenuItem onSelect={() => setRenaming(true)}>{t('rename')}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setArchived(!archived)}>{t(archived ? 'unarchive' : 'archive')}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <CreateChannelDialog projectId={projectId} open={renaming} onOpenChange={setRenaming} space={space} />
      <AddChannelMembersDialog projectId={projectId} space={space} open={adding} onOpenChange={setAdding} />
    </div>
  );
}

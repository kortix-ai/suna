'use client';

import { getProjectDetail, type ProjectSpace, type ProjectSpaceMember } from '@kortix/sdk';
import {
  contract,
  qk,
  useLeaveProjectSpace,
  usePrivateChannelsAvailable,
  useProjectSpaceMembers,
  useProjectTriggers,
  useRemoveProjectSpaceMember,
  useUpdateProjectSpace,
} from '@kortix/sdk/react';
import { DotsThreeIcon, MagnifyingGlassIcon, PencilSimpleIcon, PlusIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState, type ReactNode } from 'react';

import { useLocale, useTranslations } from '../../i18n';
import { AgentMark } from '../../internal/components/agent-mark';
import { Button } from '../../primitives/button';
import { ConfirmDialog } from '../../primitives/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../primitives/dropdown-menu';
import Hint from '../../primitives/hint';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '../../primitives/input-group';
import { Modal, ModalBody, ModalContent, ModalHeader, ModalTitle } from '../../primitives/modal';
import Loading from '../../primitives/loading';
import { Skeleton } from '../../primitives/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../primitives/tabs';
import { errorToast, successToast } from '../../primitives/toast';
import { useSessionIds } from '../../providers/session-ids';
import { ChannelGlyph } from './channel-glyph';
import { AddChannelMembersDialog, MemberAvatar } from './space-members';
import { agentLabel } from './space-timeline';

export type SpaceDetailsTab = 'about' | 'members';

/**
 * A channel's details, opened from `# name` in the header or the roster's
 * "View all members": About (name, description, default agent, who can see
 * it, when it was made, Leave, Archive) and Members (one list of its people,
 * then its agents). The pencils, Archive and the agent row menus show only
 * to the channel's creator or a project manager (`can_edit`). "Add members"
 * shows to whoever may add people (`can_add`: a member, the creator, a
 * manager) or edit the channel; its picker offers each only what they may add.
 */
export function SpaceDetailsDialog({
  space,
  tab,
  onTabChange,
  onOpenChange,
  onEdit,
  onArchive,
}: {
  space: ProjectSpace;
  /** Null: closed. */
  tab: SpaceDetailsTab | null;
  onTabChange: (tab: SpaceDetailsTab) => void;
  onOpenChange: (open: boolean) => void;
  onEdit: () => void;
  onArchive: () => void;
}) {
  const t = useTranslations('spaces.details');
  const { projectId } = useSessionIds();
  const [adding, setAdding] = useState(false);
  return (
    <>
      <Modal open={tab !== null} onOpenChange={onOpenChange}>
        <ModalContent className="lg:max-w-md">
          <ModalHeader>
            <ModalTitle className="flex min-w-0 items-center gap-1">
              <ChannelGlyph visibility={space.visibility} className="size-4 shrink-0" />
              <span className="truncate">{space.slug}</span>
            </ModalTitle>
          </ModalHeader>
          <Tabs value={tab ?? 'about'} onValueChange={(value) => onTabChange(value as SpaceDetailsTab)} className="gap-0">
            <TabsList type="underline" size="sm" className="w-full shrink-0 justify-start gap-4 px-5">
              <TabsTrigger value="about" className="w-fit flex-none">
                {t('about')}
              </TabsTrigger>
              <TabsTrigger value="members" className="w-fit flex-none">
                {t('members')}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="about">
              <AboutPane space={space} onEdit={onEdit} onArchive={onArchive} />
            </TabsContent>
            <TabsContent value="members">
              {projectId ? (
                <MembersPane projectId={projectId} space={space} onAdd={() => setAdding(true)} />
              ) : null}
            </TabsContent>
          </Tabs>
        </ModalContent>
      </Modal>
      {projectId ? (
        <AddChannelMembersDialog projectId={projectId} space={space} open={adding} onOpenChange={setAdding} />
      ) : null}
    </>
  );
}

/** Label over value, a pencil at the row's end: the channel's facts, one per row. */
function AboutPane({ space, onEdit, onArchive }: { space: ProjectSpace; onEdit: () => void; onArchive: () => void }) {
  const t = useTranslations('spaces.details');
  const locale = useLocale();
  const { projectId } = useSessionIds();
  // A message that names no agent goes to the project's default agent.
  const detail = useQuery({
    queryKey: qk.project.detail(projectId ?? ''),
    queryFn: () => getProjectDetail(projectId!),
    enabled: !!projectId,
    ...contract('config'),
  });
  // A channel with an agent list starts a new thread on its first agent.
  const channelDefault = space.agents?.[0] ?? null;
  const defaultAgent = channelDefault ?? detail.data?.config.default_agent ?? detail.data?.config.open_code_default_agent ?? null;
  const created = new Date(space.created_at).toLocaleDateString(locale, { dateStyle: 'medium' });
  // Its creator or a project manager; an older API sends no `can_edit`.
  const editable = space.can_edit !== false;
  const edit = (field: string) => (editable ? <EditButton field={field} onClick={onEdit} /> : null);
  // "Make private" shows only where the server allows private channels.
  const privateAvailable = usePrivateChannelsAvailable(projectId).data === true;

  return (
    <ModalBody className="pt-1">
      <dl className="divide-border divide-y">
        <DetailRow label={t('name')} action={edit(t('name'))}>
          #{space.slug}
        </DetailRow>
        <DetailRow label={t('description')} action={edit(t('description'))}>
          {space.description || <span className="text-muted-foreground">{t('noDescription')}</span>}
        </DetailRow>
        {defaultAgent ? (
          <DetailRow label={t('defaultAgent')} hint={channelDefault ? t('channelDefaultHint') : t('defaultAgentHint')}>
            <span className="flex items-center gap-2">
              <AgentMark slug={defaultAgent} size={14} />
              {agentLabel(defaultAgent)}
            </span>
          </DetailRow>
        ) : null}
        <DetailRow
          label={t('visibility')}
          action={
            editable && privateAvailable && !space.is_default && space.visibility !== 'private' && projectId ? (
              <MakePrivateButton projectId={projectId} space={space} />
            ) : null
          }
        >
          {space.visibility === 'private' ? t('visibilityPrivate') : t('visibilityProject')}
        </DetailRow>
        <DetailRow label={t('created')}>{created}</DetailRow>
      </dl>
      <LeaveRow projectId={projectId ?? null} space={space} />
      {space.is_default || !editable ? null : (
        <div className="flex items-center justify-between gap-4 border-t pt-4">
          <div className="min-w-0">
            <p className="text-sm font-medium">{t('archiveTitle')}</p>
            <p className="text-muted-foreground text-xs text-pretty">{t('archiveHint')}</p>
          </div>
          <Button variant="destructive" size="sm" onClick={onArchive}>
            {t('archive')}
          </Button>
        </div>
      )}
    </ModalBody>
  );
}

/**
 * Search and "Add members" on one row, then one flat list of everyone in the
 * channel: you, the other people A–Z by display name (never an email), then
 * the channel's agents in order, the first tagged Default. A person row's menu
 * is Leave channel on your own row and Remove on another's when you may; an
 * agent row's menu (Make default, Remove) shows to whoever may edit the
 * channel. People and agents not in the channel are only in the "Add members"
 * picker. A private channel ends the list with one line on who can see it.
 * `#general` is every project member, with no menus. The search filters the list.
 */
function MembersPane({ projectId, space, onAdd }: { projectId: string; space: ProjectSpace; onAdd: () => void }) {
  const t = useTranslations('spaces.details');
  const editable = space.can_edit !== false;
  const name = space.slug ?? space.name;
  const update = useUpdateProjectSpace(projectId);
  const members = useProjectSpaceMembers(projectId, space.space_id);
  const canAdd = members.data?.can_add === true;
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();

  const agents = useMemo(() => space.agents ?? [], [space.agents]);
  const people = useMemo(
    () =>
      [...(members.data?.members ?? [])].sort(
        (a, b) => Number(b.is_viewer) - Number(a.is_viewer) || a.name.localeCompare(b.name),
      ),
    [members.data],
  );
  const shownPeople = people.filter((person) => !needle || person.name.toLowerCase().includes(needle));
  const shownAgents = agents.filter(
    (agent) => !needle || agentLabel(agent).toLowerCase().includes(needle) || agent.toLowerCase().includes(needle),
  );

  const save = (next: string[], done: string) =>
    update.mutate(
      { spaceId: space.space_id, input: { agents: next } },
      { onSuccess: () => successToast(done), onError: () => errorToast(t('agentsFailed')) },
    );

  return (
    <ModalBody className="space-y-4 pt-4">
      <div className="flex items-center gap-2">
        <InputGroupSearch className="flex-1">
          <InputGroupSearchIcon>
            <MagnifyingGlassIcon />
          </InputGroupSearchIcon>
          <InputGroupSearchInput
            placeholder={t('search')}
            aria-label={t('find')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            size="sm"
          />
          <InputGroupSearchClear onClick={() => setQuery('')} />
        </InputGroupSearch>
        {canAdd || editable ? (
          <Button size="sm" variant="secondary" className="shrink-0 gap-1.5" onClick={onAdd}>
            <PlusIcon className="size-4 shrink-0" />
            {t('addMembers')}
          </Button>
        ) : null}
      </div>

      {members.isLoading ? (
        <div className="space-y-1">
          {[0, 1, 2].map((index) => (
            <div key={index} className="flex min-h-10 items-center gap-2.5">
              <Skeleton className="size-7 rounded-full" />
              <Skeleton className="h-3.5 w-32" />
            </div>
          ))}
        </div>
      ) : needle && shownPeople.length + shownAgents.length === 0 ? (
        <p className="text-muted-foreground px-3 py-6 text-center text-xs">{t('noMatches', { query: query.trim() })}</p>
      ) : (
        <div className="space-y-2">
          {/* `-mx-2`: the rows' own `px-2` puts their avatars on the search field's edge. */}
          <ul className="-mx-2">
            {shownPeople.map((person) => (
              <MemberRow
                key={person.user_id}
                avatar={<MemberAvatar member={person} />}
                name={person.name}
                tag={person.is_viewer ? t('you') : null}
                trailing={person.can_remove ? <PersonMenu projectId={projectId} space={space} person={person} /> : null}
              />
            ))}
            {shownAgents.map((agent) => {
              const isDefault = agent === agents[0];
              const label = agentLabel(agent);
              return (
                <MemberRow
                  key={agent}
                  avatar={<AgentMark slug={agent} size={21} />}
                  name={label}
                  tag={isDefault ? t('defaultTag') : t('agentTag')}
                  trailing={
                    editable ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="text-muted-foreground shrink-0"
                            aria-label={t('agentMenu', { agent: label })}
                            disabled={update.isPending}
                          >
                            <DotsThreeIcon className="size-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {isDefault ? null : (
                            <DropdownMenuItem
                              onSelect={() =>
                                save([agent, ...agents.filter((item) => item !== agent)], t('defaultSet', { agent: label, name }))
                              }
                            >
                              {t('makeDefault')}
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem
                            onSelect={() => save(agents.filter((item) => item !== agent), t('agentRemoved', { agent: label, name }))}
                          >
                            {t('removeAgent', { name })}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null
                  }
                />
              );
            })}
          </ul>
          {space.visibility === 'private' && !needle ? (
            <p className="text-muted-foreground text-xs text-pretty">{t('privateNote', { name })}</p>
          ) : null}
        </div>
      )}
    </ModalBody>
  );
}

/**
 * "Make private", for the channel's creator or a project manager, behind a
 * confirm that says what changes: only members see
 * it from then on, the people who started a thread or added a link become
 * members, everyone else loses it, it cannot be made public again, and the
 * triggers that post into it stop (the API refuses a trigger run into a
 * private channel).
 */
function MakePrivateButton({ projectId, space }: { projectId: string; space: ProjectSpace }) {
  const t = useTranslations('spaces.details');
  const update = useUpdateProjectSpace(projectId);
  const [open, setOpen] = useState(false);
  // Read once the confirm opens: the count the warning names.
  const triggers = useProjectTriggers(open ? projectId : null);
  const triggerCount = triggers.data?.triggers.filter((trigger) => trigger.space_id === space.space_id).length ?? 0;
  const name = space.slug ?? space.name;
  return (
    <>
      <Button variant="outline" size="sm" className="shrink-0" onClick={() => setOpen(true)}>
        {t('makePrivate')}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={t('makePrivateTitle', { name })}
        description={
          <div className="space-y-2">
            <p>{t('makePrivateWho', { name })}</p>
            <p>{t('makePrivateLeave')}</p>
            <p>{t('makePrivateFinal')}</p>
            {triggerCount > 0 ? <p>{t('makePrivateTriggers', { count: triggerCount })}</p> : null}
            <p>{t('privateLimits')}</p>
          </div>
        }
        confirmLabel={t('makePrivate')}
        isPending={update.isPending}
        onConfirm={() =>
          update.mutate(
            { spaceId: space.space_id, input: { visibility: 'private' } },
            {
              onSuccess: () => {
                setOpen(false);
                successToast(t('madePrivate', { name }));
              },
              // The app's mutation default toasts the server's reason (a 409
              // `private_channels_unavailable` included); a second toast here would repeat it.
            },
          )
        }
      />
    </>
  );
}

/** "Leave this channel" for a member who may leave (not the creator, nobody in `#general`). A private channel asks first. */
function LeaveRow({ projectId, space }: { projectId: string | null; space: ProjectSpace }) {
  const t = useTranslations('spaces.details');
  const members = useProjectSpaceMembers(projectId, space.is_default ? null : space.space_id);
  const leave = useLeaveProjectSpace(projectId ?? '', space.space_id);
  const [confirming, setConfirming] = useState(false);
  const self = members.data?.members.find((member) => member.is_viewer);
  if (!projectId || !self?.can_remove) return null;
  const name = space.slug ?? space.name;
  const isPrivate = space.visibility === 'private';
  const run = () =>
    leave.mutate(undefined, {
      onSuccess: () => successToast(t('left', { name })),
      onError: () => errorToast(t('peopleFailed')),
    });
  return (
    <div className="flex items-center justify-between gap-4 border-t pt-4">
      <div className="min-w-0">
        <p className="text-sm font-medium">{t('leaveTitle')}</p>
        <p className="text-muted-foreground text-xs text-pretty">{isPrivate ? t('leaveHintPrivate') : t('leaveHint')}</p>
      </div>
      <Button
        variant="outline"
        size="sm"
        disabled={leave.isPending}
        aria-busy={leave.isPending || undefined}
        onClick={() => (isPrivate ? setConfirming(true) : run())}
      >
        {leave.isPending ? <Loading className="size-4 shrink-0" /> : null}
        {t('leave')}
      </Button>
      <LeavePrivateConfirm name={name} open={confirming} onOpenChange={setConfirming} pending={leave.isPending} onConfirm={run} />
    </div>
  );
}

/** The confirm before leaving a private channel: leaving takes away every thread of it, the leaver's own too. */
function LeavePrivateConfirm({
  name,
  open,
  onOpenChange,
  pending,
  onConfirm,
}: {
  name: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
  onConfirm: () => void;
}) {
  const t = useTranslations('spaces.details');
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('leavePrivateTitle', { name })}
      description={t('leaveHintPrivate')}
      confirmLabel={t('leave')}
      confirmVariant="destructive"
      isPending={pending}
      onConfirm={() => {
        onOpenChange(false);
        onConfirm();
      }}
    />
  );
}

/** A person row's menu: Leave channel on your own row, Remove from #name on another's. */
function PersonMenu({ projectId, space, person }: { projectId: string; space: ProjectSpace; person: ProjectSpaceMember }) {
  const t = useTranslations('spaces.details');
  const name = space.slug ?? space.name;
  const remove = useRemoveProjectSpaceMember(projectId, space.space_id);
  const leave = useLeaveProjectSpace(projectId, space.space_id);
  const pending = remove.isPending || leave.isPending;
  const [confirming, setConfirming] = useState(false);
  const runLeave = () =>
    leave.mutate(undefined, {
      onSuccess: () => successToast(t('left', { name })),
      onError: () => errorToast(t('peopleFailed')),
    });
  const onSelect = () =>
    person.is_viewer
      ? space.visibility === 'private'
        ? setConfirming(true)
        : runLeave()
      : remove.mutate(person.user_id, {
          onSuccess: () => successToast(t('personRemoved', { person: person.name, name })),
          onError: () => errorToast(t('peopleFailed')),
        });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground shrink-0"
          aria-label={t('personMenu', { person: person.name })}
          disabled={pending}
        >
          <DotsThreeIcon className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={onSelect}>{person.is_viewer ? t('leave') : t('removePerson', { name })}</DropdownMenuItem>
      </DropdownMenuContent>
      <LeavePrivateConfirm name={name} open={confirming} onOpenChange={setConfirming} pending={leave.isPending} onConfirm={runLeave} />
    </DropdownMenu>
  );
}

/** Avatar, name, a muted tag ("(you)", "Agent", "Default"), then the row's menu. No hover fill: the row itself is not clickable. */
function MemberRow({ avatar, name, tag, trailing }: { avatar: ReactNode; name: string; tag?: string | null; trailing?: ReactNode }) {
  return (
    <li className="flex min-h-10 items-center gap-2.5 px-2">
      {/* One slot, the avatar's `size-8`: the 28px agent tile centres in it, so every name starts on one edge. */}
      <span className="flex size-8 shrink-0 items-center justify-center">{avatar}</span>
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <span className="truncate text-sm font-medium">{name}</span>
        {tag ? <span className="text-muted-foreground shrink-0 text-xs">{tag}</span> : null}
      </span>
      {trailing}
    </li>
  );
}

function DetailRow({
  label,
  hint,
  action,
  children,
}: {
  label: string;
  /** A short note under the value, for a fact that is set elsewhere. */
  hint?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="min-w-0 space-y-0.5">
        <dt className="text-muted-foreground text-xs font-medium">{label}</dt>
        <dd className="text-sm text-pretty wrap-anywhere">{children}</dd>
        {hint ? <p className="text-muted-foreground text-xs text-pretty">{hint}</p> : null}
      </div>
      {action}
    </div>
  );
}

/** A pencil, named for the row it edits: a screen reader has no row. */
function EditButton({ field, onClick }: { field: string; onClick: () => void }) {
  const t = useTranslations('spaces.details');
  const label = t('editField', { field });
  return (
    <Hint label={label} side="left">
      <Button variant="ghost" size="icon-sm" className="text-muted-foreground shrink-0" aria-label={label} onClick={onClick}>
        <PencilSimpleIcon className="size-3.5" />
      </Button>
    </Hint>
  );
}

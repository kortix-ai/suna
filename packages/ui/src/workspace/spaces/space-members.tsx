'use client';

import type { ProjectSpace, ProjectSpaceMember } from '@kortix/sdk';
import {
  useAddProjectSpaceMembers,
  useJoinProjectSpace,
  useProjectSpaceMembers,
  useProjectAccountId,
  useProjectName,
  useProjectSpaces,
  useUpdateProjectSpace,
  useVisibleAgents,
} from '@kortix/sdk/react';
import { EnvelopeSimpleIcon, MagnifyingGlassIcon } from '@phosphor-icons/react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import { AccessDialog } from '../../access/access/access-dialog';
import { PickerRow } from '../../access/access/principal-picker';
import { useTranslations } from '../../i18n';
import { Close } from '../../icons/close';
import { AgentMark } from '../../internal/components/agent-mark';
import { PROJECT_ACTIONS } from '../../internal/lib/project-actions';
import { useProjectCan } from '../../internal/lib/use-project-can';
import { Badge } from '../../primitives/badge';
import { Button } from '../../primitives/button';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '../../primitives/input-group';
import Loading from '../../primitives/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '../../primitives/modal';
import { errorToast, successToast } from '../../primitives/toast';
import { UserAvatar } from '../../primitives/user-avatar';
import { agentLabel } from './space-timeline';

/**
 * The project's people, by display name: `#general`'s member list, which is
 * every project member. `notIn`: the people not yet in that channel.
 */
export function useProjectPeople(projectId: string, notIn?: ProjectSpace) {
  const spaces = useProjectSpaces(projectId);
  const generalId = spaces.data?.find((space) => space.is_default)?.space_id;
  const everyone = useProjectSpaceMembers(projectId, generalId);
  const inChannel = useProjectSpaceMembers(projectId, notIn?.is_default ? null : notIn?.space_id);
  const available = useMemo(() => {
    const taken = new Set((inChannel.data?.members ?? []).map((member) => member.user_id));
    return (everyone.data?.members ?? []).filter((member) => !taken.has(member.user_id));
  }, [everyone.data, inChannel.data]);
  return { available, isLoading: everyone.isLoading || inChannel.isLoading };
}

/**
 * Invite someone to the project by email: the project's own grant dialog
 * (`AccessDialog`, the one Access → Projects opens), for a viewer who may
 * manage the project's members. `dialog` is rendered by the caller.
 */
export function useInviteToProject(projectId: string) {
  const canInvite = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE).allowed === true;
  const accountId = useProjectAccountId(canInvite ? projectId : undefined);
  const projectName = useProjectName(canInvite ? projectId : undefined) ?? '';
  const [open, setOpen] = useState(false);
  const dialog = accountId ? (
    <AccessDialog
      open={open}
      onOpenChange={setOpen}
      accountId={accountId}
      scope={{ kind: 'project', projectId, projectName }}
      mode={{ kind: 'grant' }}
    />
  ) : null;
  return { canInvite: canInvite && !!accountId, invite: () => setOpen(true), dialog };
}

/** A person's face and display name, never an email. */
export function MemberAvatar({ member, size = 'md' }: { member: ProjectSpaceMember; size?: 'xs' | 'sm' | 'md' }) {
  return <UserAvatar email="" name={member.name} avatarUrl={member.avatar_url} size={size} />;
}

/** A row of the "Add members" picker: a project member or a project agent not yet in the channel. */
type Candidate = { kind: 'person'; id: string; label: string; person: ProjectSpaceMember } | { kind: 'agent'; id: string; label: string };

const candidateKey = (candidate: Pick<Candidate, 'kind' | 'id'>) => `${candidate.kind}:${candidate.id}`;

/**
 * "Add members": one checklist of the project's people and agents not yet in
 * the channel, in the access picker's rows, People first. People show to
 * whoever may add (`can_add`), agents to whoever may edit the channel
 * (`can_edit`); an empty group is hidden. Each check adds a chip. Arrow keys
 * move the highlight across both groups from the search field; Enter checks
 * the highlighted row. The footer adds the people (one request) and appends
 * the agents in pick order (one PATCH), in parallel: on an empty agent list
 * the first agent picked becomes the default. "Invite by email" in the
 * footer opens the project's invite dialog, for someone not in the project.
 */
export function AddChannelMembersDialog({
  projectId,
  space,
  open,
  onOpenChange,
}: {
  projectId: string;
  space: ProjectSpace;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const invite = useInviteToProject(projectId);
  return (
    <>
      <Modal open={open} onOpenChange={onOpenChange}>
        <ModalContent className="lg:max-w-md">
          {/* Mounted only while open: every opening starts with no picks and no query. */}
          {open ? (
            <AddMembersForm
              projectId={projectId}
              space={space}
              onDone={() => onOpenChange(false)}
              onInvite={
                invite.canInvite
                  ? () => {
                      onOpenChange(false);
                      invite.invite();
                    }
                  : null
              }
            />
          ) : null}
        </ModalContent>
      </Modal>
      {invite.dialog}
    </>
  );
}

function AddMembersForm({
  projectId,
  space,
  onDone,
  onInvite,
}: {
  projectId: string;
  space: ProjectSpace;
  onDone: () => void;
  /** Opens the project's invite dialog; null for a viewer who may not invite. */
  onInvite: (() => void) | null;
}) {
  const t = useTranslations('spaces.addMembers');
  const canAdd = useProjectSpaceMembers(projectId, space.space_id).data?.can_add === true;
  // Its creator or a project manager; an older API sends no `can_edit`.
  const editable = space.can_edit !== false;
  const outside = space.visibility === 'private' && space.is_member === false;
  const people = useProjectPeople(projectId, canAdd ? space : undefined);
  const agents = useVisibleAgents({ projectId });
  const add = useAddProjectSpaceMembers(projectId, space.space_id);
  const update = useUpdateProjectSpace(projectId);
  const [picked, setPicked] = useState<Candidate[]>([]);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const pending = add.isPending || update.isPending;
  const name = space.slug ?? space.name;
  const current = useMemo(() => space.agents ?? [], [space.agents]);

  const personRows = useMemo<Candidate[]>(
    () =>
      canAdd
        ? people.available
            // A manager outside a private channel adds others, never themself (D1).
            .filter((person) => !(outside && person.is_viewer))
            .map((person) => ({ kind: 'person', id: person.user_id, label: person.name, person }))
        : [],
    [canAdd, outside, people.available],
  );
  const agentRows = useMemo<Candidate[]>(
    () =>
      editable
        ? agents.filter((agent) => !current.includes(agent.name)).map((agent) => ({ kind: 'agent', id: agent.name, label: agentLabel(agent.name) }))
        : [],
    [editable, agents, current],
  );
  const needle = query.trim().toLowerCase();
  // A person by display name; an agent by its label or its slug.
  const matches = (row: Candidate) =>
    !needle || row.label.toLowerCase().includes(needle) || (row.kind === 'agent' && row.id.toLowerCase().includes(needle));
  const shownPeople = personRows.filter(matches);
  const shownAgents = agentRows.filter(matches);
  // One list for the arrow keys: People, then Agents.
  const shown = [...shownPeople, ...shownAgents];
  const pickedKeys = new Set(picked.map(candidateKey));
  const toggle = (row: Candidate) =>
    setPicked((list) => (list.some((item) => candidateKey(item) === candidateKey(row)) ? list.filter((item) => candidateKey(item) !== candidateKey(row)) : [...list, row]));

  // The highlighted row stays in view as the arrow keys move it.
  useEffect(() => {
    listRef.current?.querySelector(`[data-row="${highlight}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [highlight]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setHighlight((index) => (shown.length === 0 ? 0 : (index + step + shown.length) % shown.length));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const row = shown[Math.min(highlight, shown.length - 1)];
      if (row) toggle(row);
    }
  };

  /** "1 person", "2 agents", "1 person and 2 agents". */
  const summary = (personCount: number, agentCount: number) => {
    const who = personCount > 0 ? t('peopleCount', { count: personCount }) : null;
    const what = agentCount > 0 ? t('agentsCount', { count: agentCount }) : null;
    return who && what ? t('both', { people: who, agents: what }) : (who ?? what ?? '');
  };
  const pickedPeople = picked.filter((row) => row.kind === 'person').map((row) => row.id);
  const pickedAgents = picked.filter((row) => row.kind === 'agent').map((row) => row.id);

  const submit = async () => {
    if (picked.length === 0 || pending) return;
    const [peopleResult, agentsResult] = await Promise.allSettled([
      pickedPeople.length > 0 ? add.mutateAsync(pickedPeople) : null,
      pickedAgents.length > 0 ? update.mutateAsync({ spaceId: space.space_id, input: { agents: [...current, ...pickedAgents] } }) : null,
    ]);
    const peopleFailed = peopleResult.status === 'rejected';
    const agentsFailed = agentsResult.status === 'rejected';
    if (!peopleFailed && !agentsFailed) {
      successToast(t('added', { what: summary(pickedPeople.length, pickedAgents.length), name }));
      onDone();
      return;
    }
    // Keep the part that failed selected, so a second click retries only it.
    setPicked((list) => list.filter((row) => (row.kind === 'person' ? peopleFailed : agentsFailed)));
    if (peopleFailed && agentsFailed) errorToast(t('failed'));
    else if (peopleFailed) errorToast(pickedAgents.length > 0 ? t('peopleFailedAgentsAdded', { what: summary(0, pickedAgents.length), name }) : t('peopleFailed'));
    else errorToast(pickedPeople.length > 0 ? t('agentsFailedPeopleAdded', { what: summary(pickedPeople.length, 0), name }) : t('agentsFailed'));
  };

  const loading = canAdd && people.isLoading;
  const empty = loading
    ? null
    : personRows.length + agentRows.length === 0
      ? t('allAdded')
      : shown.length === 0
        ? t('noMatches', { query: query.trim() })
        : null;
  const group = (label: string, rows: Candidate[], offset: number) =>
    rows.length === 0 ? null : (
      <div role="group" aria-label={label}>
        <h3 className="text-muted-foreground px-2 pt-2 pb-1 text-xs font-medium">{label}</h3>
        {rows.map((row, index) => (
          <div key={candidateKey(row)} data-row={offset + index}>
            <PickerRow
              selection="multi"
              selected={pickedKeys.has(candidateKey(row))}
              highlighted={offset + index === highlight}
              disabled={pending}
              onSelect={() => toggle(row)}
              // The 28px tile, as in the Members list: a person row and an agent row share one height.
              leading={row.kind === 'person' ? <MemberAvatar member={row.person} /> : <AgentMark slug={row.id} size={21} />}
              label={row.label}
            />
          </div>
        ))}
      </div>
    );

  return (
    <>
      <ModalHeader>
        <ModalTitle>{t('title', { name })}</ModalTitle>
        <ModalDescription>{t('description')}</ModalDescription>
      </ModalHeader>
      <ModalBody className="space-y-3">
        {picked.length > 0 ? (
          <ul className="flex flex-wrap gap-1.5" aria-label={t('selected')}>
            {picked.map((row) => (
              <li key={candidateKey(row)}>
                {/* A name, not a status: the sans face at the row's size, not the badge's mono caps. */}
                <Badge variant="outline" size="sm" className="gap-1.5 py-0.5 pr-0.5 pl-1 font-sans text-xs tracking-normal">
                  {row.kind === 'person' ? <MemberAvatar member={row.person} size="xs" /> : <AgentMark slug={row.id} size={14} tile={18} />}
                  {row.label}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="text-muted-foreground size-5"
                    aria-label={t('unpick', { member: row.label })}
                    disabled={pending}
                    onClick={() => toggle(row)}
                  >
                    <Close className="size-3" />
                  </Button>
                </Badge>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="border-border overflow-hidden rounded-md border">
          <InputGroupSearch className="border-b">
            <InputGroupSearchIcon>
              <MagnifyingGlassIcon />
            </InputGroupSearchIcon>
            <InputGroupSearchInput
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setHighlight(0);
              }}
              onKeyDown={onKeyDown}
              placeholder={t('search')}
              aria-label={t('search')}
              autoFocus
            />
            {query ? <InputGroupSearchClear onClick={() => setQuery('')} /> : null}
          </InputGroupSearch>
          <div ref={listRef} className="max-h-72 overflow-y-auto p-1">
            {loading ? (
              <div className="flex justify-center py-6">
                <Loading className="size-4 shrink-0" />
              </div>
            ) : empty ? (
              <div className="flex flex-col items-center gap-3 px-3 py-6">
                <p className="text-muted-foreground text-center text-xs">{empty}</p>
                {onInvite && !needle ? (
                  <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={onInvite}>
                    <EnvelopeSimpleIcon aria-hidden className="size-3.5 shrink-0" />
                    {t('inviteByEmail')}
                  </Button>
                ) : null}
              </div>
            ) : (
              <>
                {group(t('people'), shownPeople, 0)}
                {group(t('agents'), shownAgents, shownPeople.length)}
              </>
            )}
          </div>
        </div>
      </ModalBody>
      <ModalFooter className="sm:justify-between">
        {/* Someone not in the project yet is invited to the project by email. */}
        {onInvite ? (
          <Button
            type="button"
            variant="transparent"
            size="sm"
            className="text-muted-foreground hover:text-foreground h-auto p-0 text-xs font-normal"
            onClick={onInvite}
          >
            {t('inviteByEmail')}
          </Button>
        ) : (
          <span />
        )}
        <div className="flex w-full flex-col-reverse gap-2 sm:w-auto sm:flex-row">
          <Button type="button" variant="outline-ghost" onClick={onDone} disabled={pending}>
            {t('cancel')}
          </Button>
          <Button type="button" onClick={submit} disabled={picked.length === 0 || pending} aria-busy={pending || undefined}>
            {pending ? <Loading className="size-4 shrink-0" /> : null}
            {picked.length === 0 ? t('confirmEmpty') : t('confirm', { what: summary(pickedPeople.length, pickedAgents.length) })}
          </Button>
        </div>
      </ModalFooter>
    </>
  );
}

/** "Join channel", in the header of a public channel the viewer is not in. */
export function JoinChannelButton({ projectId, space }: { projectId: string; space: ProjectSpace }) {
  const t = useTranslations('spaces.view');
  const join = useJoinProjectSpace(projectId, space.space_id);
  const name = space.slug ?? space.name;
  return (
    <Button
      size="sm"
      variant="secondary"
      className="shrink-0"
      disabled={join.isPending}
      aria-busy={join.isPending || undefined}
      onClick={() =>
        join.mutate(undefined, {
          onSuccess: () => successToast(t('joined', { name })),
          onError: () => errorToast(t('joinFailed')),
        })
      }
    >
      {join.isPending ? <Loading className="size-4 shrink-0" /> : null}
      {t('join')}
    </Button>
  );
}

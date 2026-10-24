'use client';

import { getProjectDetail, type ProjectSpace } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { HashIcon, MagnifyingGlassIcon, PencilSimpleIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState, type ReactNode } from 'react';

import { useLocale, useTranslations } from '../../i18n';
import { AgentMark } from '../../internal/components/agent-mark';
import { uiRoutes } from '../../lib/routes';
import { Button } from '../../primitives/button';
import { CountBadge } from '../../primitives/count-badge';
import Hint from '../../primitives/hint';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '../../primitives/input-group';
import { Modal, ModalBody, ModalContent, ModalHeader, ModalTitle } from '../../primitives/modal';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../primitives/tabs';
import { UserAvatar } from '../../primitives/user-avatar';
import { useSessionIds } from '../../providers/session-ids';
import { useUiRouter, useUiViewerId } from '../../providers/ui-provider';
import { participantLabel } from '../../session/participants/session-participants';
import { agentLabel, type spaceRoster } from './space-timeline';

export type SpaceDetailsTab = 'about' | 'members';

/**
 * A channel's details, opened from `# name` in the header or the roster's
 * "View all members": About (name, description, default agent, who can see
 * it, when it was made, Archive) and Members (search, Add people, then People
 * and Agents with how many loaded threads each started or answered). The
 * pencils open the rename dialog, which edits both the name and the
 * description; they and Archive show only to the channel's creator or a
 * project manager (`can_edit`).
 */
export function SpaceDetailsDialog({
  space,
  roster,
  tab,
  onTabChange,
  onOpenChange,
  onEdit,
  onArchive,
}: {
  space: ProjectSpace;
  roster: ReturnType<typeof spaceRoster>;
  /** Null: closed. */
  tab: SpaceDetailsTab | null;
  onTabChange: (tab: SpaceDetailsTab) => void;
  onOpenChange: (open: boolean) => void;
  onEdit: () => void;
  onArchive: () => void;
}) {
  const t = useTranslations('spaces.details');
  const memberCount = roster.people.length + roster.agents.length;
  return (
    <Modal open={tab !== null} onOpenChange={onOpenChange}>
      <ModalContent className="lg:max-w-md">
        <ModalHeader>
          <ModalTitle className="flex min-w-0 items-center gap-1">
            <HashIcon className="size-4 shrink-0" />
            <span className="truncate">{space.slug}</span>
          </ModalTitle>
        </ModalHeader>
        <Tabs value={tab ?? 'about'} onValueChange={(value) => onTabChange(value as SpaceDetailsTab)} className="gap-0">
          <TabsList type="underline" size="sm" className="w-full shrink-0 justify-start gap-4 px-5">
            <TabsTrigger value="about" className="w-fit flex-none">
              {t('about')}
            </TabsTrigger>
            <TabsTrigger value="members" className="w-fit flex-none gap-1.5">
              {t('members')}
              <CountBadge count={memberCount} />
            </TabsTrigger>
          </TabsList>
          <TabsContent value="about">
            <AboutPane space={space} onEdit={onEdit} onArchive={onArchive} />
          </TabsContent>
          <TabsContent value="members">
            <MembersPane roster={roster} />
          </TabsContent>
        </Tabs>
      </ModalContent>
    </Modal>
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
  const defaultAgent = detail.data?.config.default_agent ?? detail.data?.config.open_code_default_agent ?? null;
  const created = new Date(space.created_at).toLocaleDateString(locale, { dateStyle: 'medium' });
  // Its creator or a project manager; an older API sends no `can_edit`.
  const editable = space.can_edit !== false;
  const edit = (field: string) => (editable ? <EditButton field={field} onClick={onEdit} /> : null);

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
          <DetailRow label={t('defaultAgent')} hint={t('defaultAgentHint')}>
            <span className="flex items-center gap-2">
              <AgentMark slug={defaultAgent} size={14} />
              {agentLabel(defaultAgent)}
            </span>
          </DetailRow>
        ) : null}
        <DetailRow label={t('visibility')}>{t('visibilityProject')}</DetailRow>
        <DetailRow label={t('created')}>{created}</DetailRow>
      </dl>
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
 * Search and Add people on one row, then People and Agents, each under a
 * "People · 6" label. A row's end says how many of the loaded threads that
 * person started or that agent answered. The search filters both groups.
 */
function MembersPane({ roster }: { roster: ReturnType<typeof spaceRoster> }) {
  const t = useTranslations('spaces.details');
  const router = useUiRouter();
  const viewerId = useUiViewerId();
  const { projectId } = useSessionIds();
  const membersHref = projectId ? uiRoutes().members(projectId) : null;
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const people = useMemo(
    () =>
      roster.people.filter(
        (person) =>
          !needle ||
          participantLabel(person).toLowerCase().includes(needle) ||
          (person.email ?? '').toLowerCase().includes(needle),
      ),
    [roster.people, needle],
  );
  const agents = useMemo(
    () => roster.agents.filter((agent) => !needle || agentLabel(agent).toLowerCase().includes(needle)),
    [roster.agents, needle],
  );

  return (
    <ModalBody className="space-y-4 pt-4">
      <div className="flex items-center gap-2">
        <InputGroupSearch className="flex-1">
          <InputGroupSearchIcon>
            <MagnifyingGlassIcon />
          </InputGroupSearchIcon>
          <InputGroupSearchInput
            placeholder={t('find')}
            aria-label={t('find')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            variant="popover"
            size="sm"
          />
          <InputGroupSearchClear onClick={() => setQuery('')} />
        </InputGroupSearch>
        {membersHref ? (
          <Button size="sm" className="shrink-0" onClick={() => router.push(membersHref)}>
            {t('addPeople')}
          </Button>
        ) : null}
      </div>
      {people.length > 0 ? (
        <MemberGroup label={t('groupCount', { label: t('people'), count: people.length })}>
          {people.map((person) => {
            const name = participantLabel(person);
            return (
              <MemberRow
                key={person.id}
                avatar={<UserAvatar email={person.email ?? ''} name={name} avatarUrl={person.avatarUrl} size="md" />}
                name={
                  <>
                    {name}
                    {person.id === viewerId ? <span className="text-muted-foreground font-normal"> {t('you')}</span> : null}
                  </>
                }
                detail={t('threads', { count: person.threads })}
              />
            );
          })}
        </MemberGroup>
      ) : null}
      {agents.length > 0 ? (
        <MemberGroup label={t('groupCount', { label: t('agents'), count: agents.length })}>
          {agents.map((agent) => (
            <MemberRow
              key={agent}
              avatar={<AgentMark slug={agent} size={21} />}
              name={agentLabel(agent)}
              detail={t('threads', { count: roster.agentThreads[agent] ?? 0 })}
            />
          ))}
        </MemberGroup>
      ) : null}
      {needle && people.length === 0 && agents.length === 0 ? (
        <p className="text-muted-foreground py-6 text-center text-sm">{t('noMatches', { query: query.trim() })}</p>
      ) : null}
      <p className="text-muted-foreground text-xs text-pretty">{t('membersHint')}</p>
    </ModalBody>
  );
}

function MemberGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="space-y-1">
      <h3 className="text-muted-foreground text-xs font-medium tabular-nums">{label}</h3>
      {/* `-mx-2`: the rows' own `px-2` lines their avatars up with the label. */}
      <ul className="-mx-2">{children}</ul>
    </section>
  );
}

/** Avatar, name, and the count at the row's end. Read-only: no hover fill. */
function MemberRow({ avatar, name, detail }: { avatar: ReactNode; name: ReactNode; detail: string }) {
  return (
    <li className="flex min-h-10 items-center gap-2.5 px-2">
      {avatar}
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{name}</span>
      <span className="text-muted-foreground shrink-0 text-xs tabular-nums">{detail}</span>
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

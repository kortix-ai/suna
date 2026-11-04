'use client';

import { ApiError, type ProjectSpace } from '@kortix/sdk';
import {
  useCreateProjectSpace,
  usePrivateChannelsAvailable,
  useProjectConfig,
  useProjectSpaceMembers,
  useProjectSpaces,
} from '@kortix/sdk/react';
import { isMyKortixAgentName, spaceSlug } from '@kortix/shared';
import { ChatCircleIcon, LockSimpleIcon } from '@phosphor-icons/react';
import { createContext, type ReactNode, useContext, useMemo } from 'react';

import { useTranslations } from '../../i18n';
import { Close } from '../../icons/close';
import { AgentMark } from '../../internal/components/agent-mark';
import { useAccountMembers } from '../../internal/account-hub/use-account-members';
import { useBillingAccountId } from '../../internal/stores/billing-account-context';
import { cn } from '../../lib/utils';
import { uiRoutes } from '../../lib/routes';
import { Button } from '../../primitives/button';
import Hint from '../../primitives/hint';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../../primitives/hover-card';
import { Label } from '../../primitives/label';
import { errorToast } from '../../primitives/toast';
import { UserAvatar } from '../../primitives/user-avatar';
import { UiLink as Link, useUiRouter, useUiViewer, useUiViewerId } from '../../providers/ui-provider';
import { SpaceAvatar } from './space-avatar';
import { isPersonalSpace, spaceDisplayName, viewerFirstName } from './space-identity';
import { agentLabel } from './space-timeline';
import { usePersonalSpaceName } from './use-personal-space-name';

/** Someone in a space: a person (by user id when known) or an agent (by name). */
export type Principal =
  | { kind: 'agent'; name: string }
  | { kind: 'person'; userId: string | null; name: string; email?: string | null; avatarUrl?: string | null };

/** `?profile=` value of a principal, and back. */
export function profileParam(principal: Principal): string | null {
  if (principal.kind === 'agent') return `agent:${principal.name}`;
  return principal.userId ? `person:${principal.userId}` : null;
}
export function parseProfileParam(value: string | null): Principal | null {
  if (!value) return null;
  const [kind, ...rest] = value.split(':');
  const id = rest.join(':');
  if (!id) return null;
  if (kind === 'agent') return { kind: 'agent', name: id };
  if (kind === 'person') return { kind: 'person', userId: id, name: '' };
  return null;
}

/**
 * Opens the Profile panel on the right of the space. Null outside a space
 * view: a card then shows no "View profile".
 */
export const ProfileContext = createContext<((principal: Principal) => void) | null>(null);

/** The project's people with their name, face, email and account role. Every source is a read the UI already makes. */
function usePeopleDirectory(projectId: string) {
  const spaces = useProjectSpaces(projectId);
  const general = spaces.data?.find((space) => space.is_default)?.space_id;
  const members = useProjectSpaceMembers(projectId, general);
  const accountMembers = useAccountMembers(useBillingAccountId());
  return useMemo(() => {
    const byId = new Map<string, { name: string; avatarUrl: string | null; email: string | null; role: string | null }>();
    for (const member of members.data?.members ?? []) {
      byId.set(member.user_id, { name: member.name, avatarUrl: member.avatar_url, email: null, role: null });
    }
    for (const member of accountMembers.data ?? []) {
      const row = byId.get(member.user_id);
      if (row) byId.set(member.user_id, { ...row, email: member.email, role: member.account_role });
    }
    return byId;
  }, [members.data, accountMembers.data]);
}

/** A person with every field the directory knows filled in. */
function usePerson(projectId: string, principal: Extract<Principal, { kind: 'person' }>) {
  const directory = usePeopleDirectory(projectId);
  const viewerId = useUiViewerId();
  const row = principal.userId ? directory.get(principal.userId) : undefined;
  return {
    name: row?.name || principal.name,
    avatarUrl: row?.avatarUrl ?? principal.avatarUrl ?? null,
    email: row?.email ?? principal.email ?? null,
    role: row?.role ?? null,
    isViewer: !!viewerId && principal.userId === viewerId,
  };
}

/**
 * "Message" a person: a private space with them, named after both people.
 * Its slug already taken (sent before): that space opens. Null where private
 * spaces are off, for the viewer themself, or for a person with no user id.
 */
function useMessagePerson(projectId: string, personId: string | null, personName: string): (() => void) | null {
  const t = useTranslations('spaces.profile');
  const viewerId = useUiViewerId();
  const router = useUiRouter();
  const create = useCreateProjectSpace(projectId);
  const privateOn = usePrivateChannelsAvailable(projectId).data === true;
  const viewer = useUiViewer();
  const me = viewerFirstName(viewer?.metadata) ?? viewer?.email?.split('@')[0] ?? '';
  if (!privateOn || !personId || personId === viewerId) return null;
  return () => {
    const first = personName.split(/\s+/)[0] ?? personName;
    const name = t('dmSpaceName', { a: me, b: first });
    const open = (slug: string) => router.push(uiRoutes().channel(projectId, slug));
    create.mutate(
      { name, visibility: 'private', member_ids: [personId] },
      {
        onSuccess: (space) => open(space.slug ?? spaceSlug(name)),
        onError: (err) =>
          err instanceof ApiError && err.status === 409 && err.code === 'slug_taken' ? open(spaceSlug(name)) : errorToast(t('messageFailed')),
      },
    );
  };
}

/** The role line: a person's account role, or "Agent". */
function useRoleLabel(role: string | null): string | null {
  const t = useTranslations('projectSelector.role');
  return role === 'owner' || role === 'admin' || role === 'member' ? t(role) : null;
}

/**
 * Wraps an avatar or a name: hovering or focusing it shows the person's or
 * agent's card; clicking opens their Profile panel (when the view has one).
 * The trigger is a button, so keyboard focus opens the card too.
 */
export function PrincipalHover({
  projectId,
  principal,
  children,
  className,
  focusable = true,
}: {
  projectId: string;
  principal: Principal;
  children: ReactNode;
  className?: string;
  /** False for an avatar beside its name: the name is the one keyboard stop. */
  focusable?: boolean;
}) {
  const openProfile = useContext(ProfileContext);
  const t = useTranslations('spaces.profile');
  const canOpen = !!openProfile && !!profileParam(principal);
  return (
    <HoverCard openDelay={400} closeDelay={120}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          tabIndex={focusable ? undefined : -1}
          aria-label={t('viewProfile', { name: principal.kind === 'agent' ? agentLabel(principal.name) : principal.name })}
          onClick={canOpen ? () => openProfile!(principal) : undefined}
          className={cn(
            'focus-visible:ring-ring inline-flex max-w-full min-w-0 items-center rounded-sm text-left outline-none focus-visible:ring-2',
            canOpen ? 'cursor-pointer' : 'cursor-default',
            className,
          )}
        >
          {children}
        </button>
      </HoverCardTrigger>
      <HoverCardContent align="start" side="top" animated={false} className="w-72 p-0">
        <PrincipalSummary projectId={projectId} principal={principal} onOpenProfile={canOpen ? () => openProfile!(principal) : undefined} />
      </HoverCardContent>
    </HoverCard>
  );
}

/** The card: avatar, name ("(you)"), role and description, then one or two actions. */
function PrincipalSummary({ projectId, principal, onOpenProfile }: { projectId: string; principal: Principal; onOpenProfile?: () => void }) {
  return principal.kind === 'agent' ? (
    <AgentSummary projectId={projectId} name={principal.name} onOpenProfile={onOpenProfile} />
  ) : (
    <PersonSummary projectId={projectId} principal={principal} onOpenProfile={onOpenProfile} />
  );
}

function AgentSummary({ projectId, name, onOpenProfile }: { projectId: string; name: string; onOpenProfile?: () => void }) {
  const t = useTranslations('spaces.profile');
  const config = useProjectConfig(projectId);
  const agent = config?.agents.find((item) => item.name === name);
  return (
    <div className="space-y-3 p-4">
      <div className="flex items-start gap-3">
        <AgentMark slug={name} size={28} tile={40} className="rounded-md" />
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="truncate text-sm font-semibold">{agentLabel(name)}</p>
          <p className="text-muted-foreground text-xs">{t('agent')}</p>
        </div>
      </div>
      {agent?.description ? <p className="text-muted-foreground line-clamp-3 text-xs text-pretty">{agent.description}</p> : null}
      {onOpenProfile ? (
        <Button variant="outline" size="sm" className="w-full" onClick={onOpenProfile}>
          {t('openProfile')}
        </Button>
      ) : null}
    </div>
  );
}

function PersonSummary({
  projectId,
  principal,
  onOpenProfile,
}: {
  projectId: string;
  principal: Extract<Principal, { kind: 'person' }>;
  onOpenProfile?: () => void;
}) {
  const t = useTranslations('spaces.profile');
  const person = usePerson(projectId, principal);
  const role = useRoleLabel(person.role);
  const message = useMessagePerson(projectId, principal.userId, person.name);
  return (
    <div className="space-y-3 p-4">
      <div className="flex items-start gap-3">
        <UserAvatar email={person.email ?? ''} name={person.name} avatarUrl={person.avatarUrl} size="lg" />
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="flex min-w-0 items-baseline gap-1.5 text-sm font-semibold">
            <span className="truncate">{person.name}</span>
            {person.isViewer ? <span className="text-muted-foreground shrink-0 text-xs font-normal">{t('you')}</span> : null}
          </p>
          {role ? <p className="text-muted-foreground text-xs">{role}</p> : null}
        </div>
      </div>
      {message || onOpenProfile ? (
        <div className="flex gap-2">
          {message ? (
            <Button variant="outline" size="sm" className="flex-1 gap-1.5" onClick={message}>
              <ChatCircleIcon className="size-3.5 shrink-0" />
              {t('message')}
            </Button>
          ) : null}
          {onOpenProfile ? (
            <Button variant="ghost" size="sm" className="flex-1" onClick={onOpenProfile}>
              {t('viewProfileShort')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The Profile panel, in the right slot of a space (where a thread or the
 * Details open). A person: their face, name, role, email, the spaces both of
 * you are in, and "Message". An agent: its mark, description, model, the
 * spaces it answers first in, its connector reach, and "Start a private
 * space". Read-only besides those actions.
 */
export function ProfilePanel({ projectId, principal, onClose }: { projectId: string; principal: Principal; onClose: () => void }) {
  const t = useTranslations('spaces.profile');
  return (
    <aside aria-label={t('heading')} className="bg-background flex min-h-0 w-full flex-1 flex-col">
      <div className="kx-titlebar-row relative flex shrink-0 items-center gap-2 px-2">
        <div className="kx-titlebar-tabs flex h-12 min-w-0 flex-1 items-center px-3">
          <h2 className="text-sm font-medium">{t('heading')}</h2>
        </div>
        <Hint label={t('close')} side="bottom">
          <Button variant="ghost" size="icon-md" aria-label={t('close')} onClick={onClose}>
            <Close />
          </Button>
        </Hint>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {principal.kind === 'agent' ? (
          <AgentProfile projectId={projectId} name={principal.name} />
        ) : (
          <PersonProfile projectId={projectId} principal={principal} />
        )}
      </div>
    </aside>
  );
}

function ProfileFact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-0.5 px-2 py-2">
      <dt className="text-muted-foreground text-xs font-medium">{label}</dt>
      <dd className="text-sm text-pretty wrap-anywhere">{children}</dd>
    </div>
  );
}

function AgentProfile({ projectId, name }: { projectId: string; name: string }) {
  const t = useTranslations('spaces.profile');
  const config = useProjectConfig(projectId);
  const spaces = useProjectSpaces(projectId);
  const personalName = usePersonalSpaceName();
  const agent = config?.agents.find((item) => item.name === name);
  const projectDefault = config?.default_agent ?? config?.open_code_default_agent ?? null;
  const defaultIn = (spaces.data ?? []).filter(
    (space) => !space.archived_at && (space.kind === 'dm' ? space.dm_agent_name === name : space.agents?.[0] === name),
  );
  const connectors = agent?.scope?.connectors;
  const label = agentLabel(name);
  return (
    <div className="space-y-5 px-5 pb-6">
      <div className="flex flex-col items-center gap-2 pt-2 text-center">
        <AgentMark slug={name} size={42} tile={56} className="rounded-md" />
        <h3 className="text-lg font-semibold">{label}</h3>
        <p className="text-muted-foreground text-sm text-pretty">{agent?.description || t('agent')}</p>
      </div>
      <Button asChild variant="outline" size="sm" className="w-full gap-1.5">
        {/* My Kortix's private space is the person's own space. */}
        <Link href={isMyKortixAgentName(name) ? `${uiRoutes().project(projectId)}/chat` : uiRoutes().dm(projectId, name)}>
          <LockSimpleIcon className="size-3.5 shrink-0" />
          {isMyKortixAgentName(name) ? t('openPersonal') : t('startPrivate', { name: label })}
        </Link>
      </Button>
      <dl className="divide-border divide-y">
        <ProfileFact label={t('model')}>{agent?.model || t('modelDefault')}</ProfileFact>
        <ProfileFact label={t('connectors')}>
          {connectors === 'all' || connectors === undefined
            ? t('connectorsAll')
            : connectors.length === 0
              ? t('connectorsNone')
              : connectors.join(', ')}
        </ProfileFact>
        {projectDefault === name ? <ProfileFact label={t('projectDefault')}>{t('projectDefaultYes')}</ProfileFact> : null}
      </dl>
      <SpaceList title={t('defaultIn')} spaces={defaultIn} projectId={projectId} personalName={personalName} empty={t('defaultInNone')} />
    </div>
  );
}

function PersonProfile({ projectId, principal }: { projectId: string; principal: Extract<Principal, { kind: 'person' }> }) {
  const t = useTranslations('spaces.profile');
  const person = usePerson(projectId, principal);
  const role = useRoleLabel(person.role);
  const message = useMessagePerson(projectId, principal.userId, person.name);
  const spaces = useProjectSpaces(projectId);
  const channels = (spaces.data ?? []).filter((space) => space.kind === 'channel' && !space.archived_at);
  return (
    <div className="space-y-5 px-5 pb-6">
      <div className="flex flex-col items-center gap-2 pt-2 text-center">
        <UserAvatar email={person.email ?? ''} name={person.name} avatarUrl={person.avatarUrl} size="xl" />
        <h3 className="flex items-baseline gap-1.5 text-lg font-semibold">
          {person.name}
          {person.isViewer ? <span className="text-muted-foreground text-sm font-normal">{t('you')}</span> : null}
        </h3>
        {role ? <p className="text-muted-foreground text-sm">{role}</p> : null}
      </div>
      {message ? (
        <Button variant="outline" size="sm" className="w-full gap-1.5" onClick={message}>
          <ChatCircleIcon className="size-3.5 shrink-0" />
          {t('message')}
        </Button>
      ) : null}
      {person.email ? (
        <dl className="divide-border divide-y">
          <ProfileFact label={t('email')}>{person.email}</ProfileFact>
        </dl>
      ) : null}
      {principal.userId ? (
        <section className="space-y-1">
          <Label className="text-muted-foreground px-2 text-xs font-medium">{t(person.isViewer ? 'yourSpaces' : 'sharedSpaces')}</Label>
          <ul>
            {channels.map((space) => (
              <SharedSpaceRow key={space.space_id} projectId={projectId} space={space} userId={principal.userId!} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/** One space both of you are in: drawn only when its member list holds the person. */
function SharedSpaceRow({ projectId, space, userId }: { projectId: string; space: ProjectSpace; userId: string }) {
  const members = useProjectSpaceMembers(projectId, space.space_id);
  if (!members.data?.members.some((member) => member.user_id === userId)) return null;
  return <SpaceLinkRow projectId={projectId} space={space} name={space.name || space.slug || ''} />;
}

function SpaceList({
  title,
  spaces,
  projectId,
  personalName,
  empty,
}: {
  title: string;
  spaces: readonly ProjectSpace[];
  projectId: string;
  personalName: string;
  empty: string;
}) {
  return (
    <section className="space-y-1">
      <Label className="text-muted-foreground px-2 text-xs font-medium">{title}</Label>
      {spaces.length === 0 ? <p className="text-muted-foreground px-2 py-1 text-xs">{empty}</p> : null}
      <ul>
        {spaces.map((space) => (
          <SpaceLinkRow key={space.space_id} projectId={projectId} space={space} name={spaceDisplayName(space, personalName)} />
        ))}
      </ul>
    </section>
  );
}

function SpaceLinkRow({ projectId, space, name }: { projectId: string; space: ProjectSpace; name: string }) {
  const href = isPersonalSpace(space)
    ? `${uiRoutes().project(projectId)}/chat`
    : space.kind === 'dm'
      ? uiRoutes().dm(projectId, space.dm_agent_name ?? '')
      : uiRoutes().channel(projectId, space.slug ?? '');
  return (
    <li>
      <Link
        href={href}
        className="hover:bg-hover focus-visible:ring-ring flex min-h-9 items-center gap-2.5 rounded-md px-2 outline-none focus-visible:ring-2"
      >
        <SpaceAvatar space={space} size="sm" label={name} />
        <span className="min-w-0 flex-1 truncate text-sm">{name}</span>
      </Link>
    </li>
  );
}

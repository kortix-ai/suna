'use client';

import type { ProjectSpace, ProjectSpaceMember } from '@kortix/sdk';
import {
  qk,
  useFeatureFlag,
  useProjectConfig,
  useProjectSpaceMembers,
  useProjectSpaceProactive,
  useProjectTriggers,
  useSetProjectSpaceProactive,
  useUpdateProjectSpace,
} from '@kortix/sdk/react';
import { DotsThreeIcon, LightningIcon, LockSimpleIcon, PencilSimpleIcon, PlusIcon } from '@phosphor-icons/react';
import { useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useRef, useState } from 'react';

import { describeWhen, triggerName } from '../../customize/triggers/schedule/schedule-copy';
import { TriggerComposer } from '../../customize/triggers/schedule/trigger-composer';
import { useTriggerControls } from '../../customize/triggers/schedule/trigger-controls';
import { useTranslations } from '../../i18n';
import { Close } from '../../icons/close';
import { AgentMark } from '../../internal/components/agent-mark';
import { cn } from '../../lib/utils';
import { uiRoutes } from '../../lib/routes';
import { Button } from '../../primitives/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '../../primitives/dropdown-menu';
import Hint from '../../primitives/hint';
import { Label } from '../../primitives/label';
import { Switch } from '../../primitives/switch';
import { errorToast, successToast } from '../../primitives/toast';
import { UserAvatar } from '../../primitives/user-avatar';
import { UiLink as Link, useUiViewer } from '../../providers/ui-provider';
import { type Principal, PrincipalRow } from './principal-card';
import { SpaceAvatar } from './space-avatar';
import { isPersonalSpace, isPrivateSpace, viewerDisplayName } from './space-identity';
import { AddChannelMembersDialog, MemberAvatar } from './space-members';
import { AddTabMenu, KIND_ICON, useSpaceTabs } from './space-tabs';
import { agentLabel } from './space-timeline';

/**
 * A space's details, on the right of the space (flag `chat`), opened from its
 * name in the header: its tile, name and description, then Agents (the
 * default first), People, Tabs and Routines, each with its own "Add", and
 * Proactive (flag `spaces_proactive`). The
 * rarer settings (make private, leave, archive, member menus) stay in the
 * full settings dialog, one link at the end. Everything here can also be
 * asked for in chat: the hint line says so.
 */
export function SpaceDetailsPanel({
  projectId,
  space,
  name,
  onClose,
  onOpenTab,
  onRename,
  onOpenSettings,
  addOnOpen = false,
  focusPeople = false,
}: {
  projectId: string;
  space: ProjectSpace;
  /** The space's display name (the personal space's "Ada's space"). */
  name: string;
  onClose: () => void;
  /** A tab was added: open it. */
  onOpenTab: (tabId: string) => void;
  /** Rename and describe: the channel's edit dialog. Absent: no pencil. */
  onRename?: () => void;
  /** The full settings dialog. Absent: no link. */
  onOpenSettings?: () => void;
  /** Open "Add members" at once: a space just created. */
  addOnOpen?: boolean;
  /** Opened from "View all members": People scrolls into view. */
  focusPeople?: boolean;
}) {
  const peopleRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusPeople) peopleRef.current?.scrollIntoView({ block: 'start' });
  }, [focusPeople]);
  const t = useTranslations('spaces.panel');
  const channel = space.kind === 'channel' ? space : null;
  const editable = space.can_edit !== false;
  const members = useProjectSpaceMembers(projectId, channel?.space_id);
  const canAdd = !!channel && (members.data?.can_add === true || editable);
  const [adding, setAdding] = useState(addOnOpen && canAdd);
  // "Add members" opens once the members' rights are known.
  const [addPending, setAddPending] = useState(addOnOpen);
  if (addPending && members.data) {
    setAddPending(false);
    if (canAdd) setAdding(true);
  }

  return (
    <aside aria-label={t('title', { name })} className="bg-background flex min-h-0 w-full flex-1 flex-col">
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
        <div className="flex flex-col items-center gap-2 px-6 pt-2 pb-6 text-center">
          <SpaceAvatar space={space} size="xl" label={name} projectId={projectId} />
          <div className="flex min-w-0 items-center gap-1.5">
            <h3 className="truncate text-lg font-semibold">{name}</h3>
            {isPrivateSpace(space) ? (
              <LockSimpleIcon role="img" aria-label={t('private')} className="text-muted-foreground size-3.5 shrink-0" />
            ) : null}
            {onRename && editable ? (
              <Hint label={t('rename')} side="bottom">
                <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label={t('rename')} onClick={onRename}>
                  <PencilSimpleIcon className="size-3.5" />
                </Button>
              </Hint>
            ) : null}
          </div>
          <p className="text-muted-foreground text-sm text-pretty">
            {space.description || (isPersonalSpace(space) ? t('personalDescription') : isPrivateSpace(space) ? t('privateDescription') : t('noDescription'))}
          </p>
        </div>

        <div className="space-y-6 px-4 pb-6">
          <AgentsSection projectId={projectId} space={space} editable={!!channel && editable} />
          <div ref={peopleRef} className="scroll-mt-2">
          <PeopleSection projectId={projectId} space={space} members={members.data?.members} onAdd={canAdd ? () => setAdding(true) : undefined} />
          </div>
          <TabsSection projectId={projectId} space={space} onOpenTab={onOpenTab} />
          <RoutinesSection projectId={projectId} space={space} />
          <ProactiveSection projectId={projectId} space={space} />
          {onOpenSettings ? (
            <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground" onClick={onOpenSettings}>
              {t('allSettings')}
            </Button>
          ) : null}
        </div>
      </div>
      <p className="text-muted-foreground shrink-0 border-t px-5 py-3 text-xs text-pretty">{t('askHint')}</p>
      {channel ? (
        <AddChannelMembersDialog projectId={projectId} space={channel} open={adding} onOpenChange={setAdding} />
      ) : null}
    </aside>
  );
}

/** A section: its label, its rows, then its "Add" when the viewer may add. */
function Section({ title, add, children }: { title: string; add?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-1">
      <Label className="text-muted-foreground px-2 text-xs font-medium">{title}</Label>
      <ul>{children}</ul>
      {add}
    </section>
  );
}

/** One row: a 28px avatar slot, the name, a muted tag at the end. */
function Row({
  avatar,
  name,
  tag,
  href,
  card,
}: {
  avatar: ReactNode;
  name: string;
  tag?: string | null;
  href?: string | null;
  /** A person or an agent: the row opens their card and profile. */
  card?: { projectId: string; principal: Principal };
}) {
  const body = (
    <>
      <span className="flex size-7 shrink-0 items-center justify-center">{avatar}</span>
      <span className="min-w-0 flex-1 truncate text-sm">{name}</span>
      {tag ? <span className="text-muted-foreground shrink-0 text-xs">{tag}</span> : null}
    </>
  );
  // A person or an agent: THE principal row (card on hover, Profile on click).
  if (card) return <PrincipalRow projectId={card.projectId} principal={card.principal} avatar={avatar} name={name} tag={tag} />;
  return (
    <li>
      {href ? (
        <Link href={href} className="hover:bg-hover focus-visible:ring-ring flex min-h-9 items-center gap-2.5 rounded-md px-2 outline-none focus-visible:ring-2">
          {body}
        </Link>
      ) : (
        <div className="flex min-h-9 items-center gap-2.5 px-2">{body}</div>
      )}
    </li>
  );
}

function AddButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground gap-1.5" onClick={onClick}>
      <PlusIcon className="size-3.5 shrink-0" />
      {label}
    </Button>
  );
}

/**
 * The space's agents, the default first: the agents its threads hand work to
 * (the router routes only to them). A channel's editor makes one the default
 * (moves it first), removes one, and adds a project agent from a picker.
 */
function AgentsSection({ projectId, space, editable }: { projectId: string; space: ProjectSpace; editable: boolean }) {
  const t = useTranslations('spaces.panel');
  const tDetails = useTranslations('spaces.details');
  const config = useProjectConfig(projectId);
  const update = useUpdateProjectSpace(projectId);
  const projectDefault = config?.default_agent ?? null;
  const agents = space.kind === 'dm' ? (space.dm_agent_name ? [space.dm_agent_name] : []) : (space.agents ?? []);
  // No agent list: a new thread starts on the project's default agent.
  const shown = agents.length > 0 ? agents : projectDefault ? [projectDefault] : [];
  const spaceName = space.slug ?? space.name;
  const addable = (config?.agents ?? [])
    .filter((agent) => !agent.hidden && agent.enabled !== false && agent.mode !== 'subagent')
    .filter((agent) => !agents.includes(agent.name));
  const save = (next: string[], done: string) =>
    update.mutate(
      { spaceId: space.space_id, input: { agents: next } },
      { onSuccess: () => successToast(done), onError: () => errorToast(tDetails('agentsFailed')) },
    );
  const add = editable ? (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground gap-1.5" disabled={update.isPending}>
          <PlusIcon className="size-3.5 shrink-0" />
          {t('addAgent')}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        {addable.length === 0 ? (
          <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">{t('noAgentsToAdd')}</DropdownMenuLabel>
        ) : (
          addable.map((agent) => (
            <DropdownMenuItem
              key={agent.name}
              className="gap-2.5"
              onSelect={() =>
                // An empty list ran on the project's default: adding keeps that agent first, so the default does not move.
                save(
                  agents.length === 0 && projectDefault && projectDefault !== agent.name ? [projectDefault, agent.name] : [...agents, agent.name],
                  tDetails('agentAdded', { agent: agentLabel(agent.name), name: spaceName }),
                )
              }
            >
              <AgentMark slug={agent.name} size={21} />
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-sm">{agentLabel(agent.name)}</span>
                {agent.description ? <span className="text-muted-foreground truncate text-xs">{agent.description}</span> : null}
              </span>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  ) : null;
  return (
    <Section title={t('agents')} add={add}>
      {shown.map((agent, index) => {
        const label = agentLabel(agent);
        const isDefault = index === 0;
        // The project's default stands in for an empty list: nothing to move or remove.
        const listed = agents.includes(agent);
        return (
          <PrincipalRow
            key={agent}
            projectId={projectId}
            principal={{ kind: 'agent', name: agent }}
            avatar={<AgentMark slug={agent} size={21} />}
            name={label}
            tag={isDefault ? (listed ? t('default') : t('projectDefault')) : null}
            actions={
              editable && listed ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="text-muted-foreground shrink-0"
                      aria-label={tDetails('agentMenu', { agent: label })}
                      disabled={update.isPending}
                    >
                      <DotsThreeIcon className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {isDefault ? null : (
                      <DropdownMenuItem
                        onSelect={() => save([agent, ...agents.filter((item) => item !== agent)], tDetails('defaultSet', { agent: label, name: spaceName }))}
                      >
                        {tDetails('makeDefault')}
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem
                      onSelect={() => save(agents.filter((item) => item !== agent), tDetails('agentRemoved', { agent: label, name: spaceName }))}
                    >
                      {tDetails('removeAgent', { name: spaceName })}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null
            }
          />
        );
      })}
    </Section>
  );
}

/** The space's people: its members, or only the viewer in a private space of one person. */
function PeopleSection({
  projectId,
  space,
  members,
  onAdd,
}: {
  projectId: string;
  space: ProjectSpace;
  members: readonly ProjectSpaceMember[] | undefined;
  onAdd?: () => void;
}) {
  const t = useTranslations('spaces.panel');
  const viewer = useUiViewer();
  if (space.kind === 'dm') {
    const displayName = viewerDisplayName(viewer);
    return (
      <Section title={t('people')}>
        <Row
          avatar={<UserAvatar email={viewer?.email ?? ''} name={displayName} avatarUrl={typeof viewer?.metadata?.avatar_url === 'string' ? viewer.metadata.avatar_url : null} colorKey={viewer?.id} size="sm" />}
          name={t('you')}
          card={viewer ? { projectId, principal: { kind: 'person', userId: viewer.id, name: displayName } } : undefined}
        />
      </Section>
    );
  }
  const people = [...(members ?? [])].sort((a, b) => Number(b.is_viewer) - Number(a.is_viewer) || a.name.localeCompare(b.name));
  return (
    <Section title={t('people')} add={onAdd ? <AddButton label={t('addPeople')} onClick={onAdd} /> : null}>
      {people.map((person) => (
        <Row
          key={person.user_id}
          avatar={<MemberAvatar member={person} size="sm" />}
          name={person.name}
          card={{ projectId, principal: { kind: 'person', userId: person.user_id, name: person.name, avatarUrl: person.avatar_url } }}
          tag={person.is_viewer ? t('you') : null}
        />
      ))}
    </Section>
  );
}

/** The space's tabs after Chat; "Add tab" is the tab row's own menu. */
function TabsSection({ projectId, space, onOpenTab }: { projectId: string; space: ProjectSpace; onOpenTab: (id: string) => void }) {
  const t = useTranslations('spaces.panel');
  const state = useSpaceTabs(projectId, space);
  return (
    <Section
      title={t('tabs')}
      add={state.canEdit ? <AddTabMenu projectId={projectId} space={space} state={state} onAdded={onOpenTab} label={t('addTab')} /> : null}
    >
      {state.tabs.map((tab) => {
        const Icon = KIND_ICON[tab.kind];
        return (
          <li key={tab.id}>
            <button
              type="button"
              onClick={() => onOpenTab(tab.id)}
              className="hover:bg-hover focus-visible:ring-ring flex min-h-9 w-full items-center gap-2.5 rounded-md px-2 text-left outline-none focus-visible:ring-2"
            >
              <span className="text-muted-foreground flex size-7 shrink-0 items-center justify-center">
                {Icon ? <Icon className="size-4" /> : null}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm">{tab.title}</span>
            </button>
          </li>
        );
      })}
    </Section>
  );
}

/**
 * The routines that post into this space (the project's triggers with this
 * `space_id`). A private channel takes none: the API refuses a trigger into it.
 */
function RoutinesSection({ projectId, space }: { projectId: string; space: ProjectSpace }) {
  const t = useTranslations('spaces.panel');
  const queryClient = useQueryClient();
  const listing = useProjectTriggers(projectId);
  const controls = useTriggerControls(projectId);
  const [creating, setCreating] = useState(false);
  const routines = listing.data?.triggers.filter((trigger) => trigger.space_id === space.space_id) ?? [];
  const privateChannel = space.kind === 'channel' && space.visibility === 'private';
  const canAdd = controls.canCreate && !privateChannel;
  const add = canAdd ? (
    <>
      <AddButton label={t('addRoutine')} onClick={() => setCreating(true)} />
      <TriggerComposer
        projectId={projectId}
        open={creating}
        onOpenChange={setCreating}
        initialSpace={{ spaceId: space.space_id, kind: space.kind }}
        // A DM-backed space runs its one agent (the API rejects any other).
        initialAgent={space.kind === 'dm' ? space.dm_agent_name : null}
        onCreated={() => {
          setCreating(false);
          void queryClient.invalidateQueries({ queryKey: qk.project.triggers(projectId) });
        }}
      />
    </>
  ) : null;
  return (
    <Section title={t('routines')} add={add}>
      {routines.map((trigger) => (
        <Row
          key={trigger.slug}
          avatar={<LightningIcon className="text-muted-foreground size-4" />}
          name={triggerName(trigger)}
          tag={describeWhen(trigger)}
          href={uiRoutes().customize(projectId, `triggers?id=${encodeURIComponent(trigger.slug)}`)}
        />
      ))}
      {privateChannel && routines.length === 0 ? (
        <li className="text-muted-foreground px-2 py-1 text-xs text-pretty">{t('routinesPrivate')}</li>
      ) : null}
    </Section>
  );
}

/** The browser's IANA zone, for the daily brief; UTC when it has none. */
function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** One switch row: the name, a muted line under it, the switch at the end. */
function SwitchRow({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <li className="flex min-h-9 items-center gap-2.5 px-2 py-1">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">{label}</p>
        <p className="text-muted-foreground text-xs text-pretty">{hint}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} aria-label={label} className="shrink-0" />
    </li>
  );
}

/**
 * Proactive (flag `spaces_proactive`): the space's watcher reads what happens
 * here and writes only when it matters; the daily brief adds one summary at
 * 9:00. Only the space's creator, a project manager or the DM's owner may
 * change them (`can_edit`); everyone else sees the state.
 */
function ProactiveSection({ projectId, space }: { projectId: string; space: ProjectSpace }) {
  const t = useTranslations('spaces.panel');
  const flag = useFeatureFlag(projectId, 'spaces_proactive');
  const settings = useProjectSpaceProactive(projectId, space.space_id, { enabled: flag.enabled });
  const update = useSetProjectSpaceProactive(projectId, space.space_id);
  if (!flag.enabled || !settings.data) return null;
  const { enabled, daily_brief: dailyBrief, can_edit: canEdit } = settings.data;
  const save = (input: Parameters<typeof update.mutate>[0]) =>
    update.mutate(input, { onError: () => errorToast(t('proactiveFailed')) });
  return (
    <Section title={t('proactive')}>
      <SwitchRow
        label={t('proactiveWatch')}
        hint={t('proactiveWatchHint')}
        checked={enabled}
        disabled={!canEdit || update.isPending}
        onChange={(next) => save({ enabled: next })}
      />
      {enabled ? (
        <SwitchRow
          label={t('proactiveBrief')}
          hint={t('proactiveBriefHint')}
          checked={dailyBrief}
          disabled={!canEdit || update.isPending}
          onChange={(next) => save(next ? { daily_brief: true, brief_timezone: browserTimeZone() } : { daily_brief: false })}
        />
      ) : null}
    </Section>
  );
}

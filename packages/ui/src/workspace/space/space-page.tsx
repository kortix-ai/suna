'use client';

import type { ReactNode } from 'react';

import {
  agentsInSpace,
  listSpaces,
  spaceHeader,
  spaceTabKey,
  spaceTabs,
  type ProjectSpace,
  type SpaceTab,
} from '@kortix/sdk';
import {
  sessionNeedsInputCount,
  useFeatureFlag,
  useProjectConfig,
  useProjectSessions,
  useRoom,
  useSessionsNeedingInput,
  useSpaceRoom,
} from '@kortix/sdk/react';
import { HashIcon, PlusIcon } from '@phosphor-icons/react';

import { useConfigureThread } from '../../customize/use-configure-thread';
import { useTranslations } from '../../i18n';
import { AgentMark } from '../../internal/components/agent-mark';
import { ProjectPageHeader } from '../../internal/layout/project-page-header';
import { agentHref } from '../../internal/lib/capability-tab-routes';
import { PROJECT_ACTIONS } from '../../internal/lib/project-actions';
import { useProjectCan } from '../../internal/lib/use-project-can';
import { useActiveSpace } from '../../internal/stores/active-space-store';
import { uiRoutes } from '../../lib/routes';
import { UiLink as Link, useUiPathname, useUiRouter, useUiSearchParams } from '../../providers/ui-provider';
import { Button } from '../../primitives/button';
import { CountBadge } from '../../primitives/count-badge';
import { EmptyState } from '../../primitives/empty-state';
import { Tabs, TabsList, TabsTrigger } from '../../primitives/tabs';
import { UserAvatar } from '../../primitives/user-avatar';
import { SpaceTabMenu } from './space-tab-menu';
import { SpaceTabPanel, useTabLabel } from './space-tab-panels';

/** The key of the room tab, always first. */
export const ROOM_TAB = 'room';

/** The tabs a viewer sees, in order: a tab of a feature the project has off is hidden. */
export function visibleSpaceTabs(
  space: ProjectSpace,
  flags: { goals: boolean; artifacts: boolean },
): Array<{ key: string; tab: SpaceTab; index: number }> {
  return spaceTabs(space)
    .map((tab, index) => ({ key: spaceTabKey(tab, index), tab, index }))
    .filter(({ tab }) => {
      if (tab.type === 'goals') return flags.goals;
      if (tab.type === 'artifacts' || tab.type === 'artifact') return flags.artifacts;
      return true;
    });
}

/**
 * /projects/[id]/spaces/[slug]: a space is a channel. The header names it and
 * shows what `spaces.<slug>.header` picks (its agents, the people in its room,
 * the sessions that wait on you, and the actions). The first tab is always the
 * room; the tabs after it come from `spaces.<slug>.tabs`. `?tab=` deep links a
 * tab. The "+" menu and Edit tabs write the same manifest list.
 */
export function SpacePage({ projectId, slug }: { projectId: string; slug: string }) {
  const t = useTranslations('spaces');
  const config = useProjectConfig(projectId);
  const goalsOn = useFeatureFlag(projectId, 'goals').enabled;
  const artifactsOn = useFeatureFlag(projectId, 'artifacts').enabled;
  const canWrite = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_FILE_WRITE).allowed === true;
  const router = useUiRouter();
  const pathname = useUiPathname();
  const params = useUiSearchParams();
  const space = config ? listSpaces(config).find((candidate) => candidate.name === slug) : undefined;

  if (!config) return <ProjectPageHeader title={`# ${slug}`} />;
  if (!space) {
    return (
      <div className="flex h-svh flex-col overflow-hidden">
        <ProjectPageHeader title={`# ${slug}`} />
        <div className="flex flex-1 items-center justify-center px-4">
          <EmptyState
            title={t('gone.title')}
            description={t('gone.hint')}
            action={
              <Button asChild size="sm" variant="outline">
                <Link href={uiRoutes().project(projectId)}>{t('gone.back')}</Link>
              </Button>
            }
          />
        </div>
      </div>
    );
  }

  const label = space.label || space.name;
  const tabs = visibleSpaceTabs(space, { goals: goalsOn, artifacts: artifactsOn });
  const requested = params.get('tab');
  const active = tabs.some((entry) => entry.key === requested) ? requested! : ROOM_TAB;
  const selectTab = (key: string) => {
    router.replace(key === ROOM_TAB ? pathname : `${pathname}?tab=${encodeURIComponent(key)}`);
  };

  return (
    <div className="flex h-svh flex-col overflow-hidden">
      <ProjectPageHeader title={label} />
      <SpaceHeader projectId={projectId} space={space} />
      <Tabs value={active} onValueChange={selectTab} className="flex min-h-0 flex-1 flex-col gap-0">
        {/* The list spans the pane so its rule runs edge to edge; "+" sits right after the last tab. */}
        <TabsList type="underline" className="w-full shrink-0 justify-start gap-1 overflow-x-auto px-4 md:px-8">
          <TabsTrigger value={ROOM_TAB} className="w-fit flex-none">
            {t('tabs.room')}
          </TabsTrigger>
          {tabs.map((entry) => (
            <SpaceTabTrigger key={entry.key} value={entry.key} tab={entry.tab} />
          ))}
          {canWrite ? (
            <SpaceTabMenu projectId={projectId} space={space} onAdded={selectTab}>
              <Button size="icon-sm" variant="ghost" aria-label={t('addTab')} className="ml-1 shrink-0">
                <PlusIcon />
              </Button>
            </SpaceTabMenu>
          ) : null}
        </TabsList>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <SpaceTabPanel
            projectId={projectId}
            space={space}
            tab={active === ROOM_TAB ? null : (tabs.find((entry) => entry.key === active)?.tab ?? null)}
          />
        </div>
      </Tabs>
    </div>
  );
}

function SpaceTabTrigger({ value, tab }: { value: string; tab: SpaceTab }) {
  const label = useTabLabel(tab);
  return (
    <TabsTrigger value={value} className="w-fit flex-none">
      {label}
    </TabsTrigger>
  );
}

/** The space's name, its description and the header strip. */
function SpaceHeader({ projectId, space }: { projectId: string; space: ProjectSpace }) {
  const config = useProjectConfig(projectId);
  const roomsOn = useFeatureFlag(projectId, 'agent_rooms').enabled;
  // `builtin_agents.my_kortix: false` turns My Kortix off: no Ask button then.
  const items = spaceHeader(space).filter(
    (item) => item !== 'ask_my_kortix' || config?.builtin_agents?.my_kortix !== false,
  );
  const agents = agentsInSpace(space.name, config?.agents ?? []);
  const show = (item: (typeof items)[number]) => items.includes(item);
  const strip: ReactNode[] = [];
  for (const item of items) {
    if (item === 'agents' && agents.length) strip.push(<SpaceAgents key={item} projectId={projectId} agents={agents} />);
    if (item === 'members' && roomsOn) strip.push(<SpaceMembers key={item} projectId={projectId} slug={space.name} />);
    if (item === 'needs_you') strip.push(<SpaceNeedsYou key={item} projectId={projectId} agents={agents} />);
  }

  return (
    <header className="flex shrink-0 flex-col gap-3 px-4 pt-5 pb-3 md:px-8">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <span aria-hidden className="bg-muted text-foreground flex size-8 shrink-0 items-center justify-center rounded-md">
            <HashIcon className="size-4" weight="bold" />
          </span>
          <h2 className="text-foreground min-w-0 truncate text-xl font-medium">{space.label || space.name}</h2>
        </div>
        {show('new_session') || show('ask_my_kortix') ? (
          <div className="flex shrink-0 items-center gap-2">
            {show('ask_my_kortix') ? <AskMyKortix projectId={projectId} space={space} /> : null}
            {show('new_session') ? <NewSessionInSpace projectId={projectId} slug={space.name} /> : null}
          </div>
        ) : null}
      </div>
      {space.description || strip.length ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {space.description ? (
            <p className="text-muted-foreground min-w-0 flex-1 text-sm text-pretty">{space.description}</p>
          ) : (
            <span className="flex-1" />
          )}
          {strip.length ? <div className="flex shrink-0 items-center gap-4">{strip}</div> : null}
        </div>
      ) : null}
    </header>
  );
}

function SpaceAgents({ projectId, agents }: { projectId: string; agents: string[] }) {
  const t = useTranslations('spaces');
  return (
    <span role="group" aria-label={t('agents')} className="flex items-center gap-1">
      {agents.map((name) => (
        <Link key={name} href={agentHref(projectId, name)} className="rounded-sm" aria-label={t('openAgent', { name })}>
          <AgentMark slug={name} />
        </Link>
      ))}
    </span>
  );
}

/** The people in the space's room. Nothing before the room exists. */
function SpaceMembers({ projectId, slug }: { projectId: string; slug: string }) {
  const t = useTranslations('spaces');
  const room = useSpaceRoom(projectId, slug);
  const detail = useRoom(projectId, room.data?.room_id ?? null);
  const people = (detail.data?.members ?? []).filter((member) => member.kind === 'person');
  if (!people.length) return null;
  return (
    <span className="flex items-center gap-1.5" aria-label={t('members', { count: people.length })}>
      <span className="flex -space-x-1">
        {people.slice(0, 3).map((person) => (
          <UserAvatar key={person.member_id} name={person.label} email={person.user_id ?? person.label} size="xs" ring hint={person.label} />
        ))}
      </span>
      <span className="text-muted-foreground text-xs tabular-nums">{t('members', { count: people.length })}</span>
    </span>
  );
}

/** The sessions of the space's agents that wait on the viewer. Hidden at 0. */
function SpaceNeedsYou({ projectId, agents }: { projectId: string; agents: string[] }) {
  const t = useTranslations('spaces');
  const summary = useSessionsNeedingInput(projectId, { enabled: agents.length > 0 });
  const { sessions } = useProjectSessions(projectId, { enabled: agents.length > 0 && !!summary.data?.total });
  const count = sessions
    .filter((session) => session.agent_name && agents.includes(session.agent_name))
    .reduce((sum, session) => sum + sessionNeedsInputCount(summary.data, session), 0);
  if (!count) return null;
  const href = uiRoutes().sessions(projectId);
  const body = (
    <>
      <CountBadge count={count} tone="waiting" />
      <span className="text-foreground text-xs">{t('needsYou')}</span>
    </>
  );
  return href ? (
    <Link href={href} className="hover:bg-hover flex items-center gap-1.5 rounded-sm px-1 transition-colors">
      {body}
    </Link>
  ) : (
    <span className="flex items-center gap-1.5">{body}</span>
  );
}

function NewSessionInSpace({ projectId, slug }: { projectId: string; slug: string }) {
  const t = useTranslations('spaces');
  const router = useUiRouter();
  const [, setActive] = useActiveSpace(projectId);
  return (
    <Button
      size="sm"
      onClick={() => {
        // The project home with the space active: the composer starts only this space's agents.
        setActive(slug);
        router.push(uiRoutes().project(projectId));
      }}
    >
      <PlusIcon />
      {t('newSession')}
    </Button>
  );
}

function AskMyKortix({ projectId, space }: { projectId: string; space: ProjectSpace }) {
  const t = useTranslations('spaces');
  const configure = useConfigureThread(projectId);
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={configure.pending}
      aria-busy={configure.pending || undefined}
      onClick={() =>
        configure.start({
          text: t('askPrompt', { name: space.label || space.name, slug: space.name }),
          agent: 'meta',
          model: null,
          variant: null,
        })
      }
    >
      <AgentMark slug="meta" />
      {t('askMyKortix')}
    </Button>
  );
}

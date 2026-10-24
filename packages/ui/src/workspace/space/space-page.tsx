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
import { SidebarToggle } from '../../internal/layout/sidebar-toggle';
import { agentHref } from '../../internal/lib/capability-tab-routes';
import { PROJECT_ACTIONS } from '../../internal/lib/project-actions';
import { useProjectCan } from '../../internal/lib/use-project-can';
import { useActiveSpace } from '../../internal/stores/active-space-store';
import { uiRoutes } from '../../lib/routes';
import { UiLink as Link, useUiPathname, useUiRouter, useUiSearchParams } from '../../providers/ui-provider';
import { Button } from '../../primitives/button';
import { CountBadge } from '../../primitives/count-badge';
import { EmptyState } from '../../primitives/empty-state';
import { useOptionalSidebar } from '../../primitives/sidebar';
import { Tabs, TabsList, TabsTrigger } from '../../primitives/tabs';
import { UserAvatar } from '../../primitives/user-avatar';
import { SpaceTabMenu } from './space-tab-menu';
import { SpaceTabPanel, useTabLabel } from './space-tab-panels';

/** The key of the room tab, always first. */
export const ROOM_TAB = 'room';

/** How many faces a pile shows before "+N". */
const PILE = 4;

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
 * /projects/[id]/spaces/[slug]: a space is a channel. One header block: the
 * title bar names it and shows what `spaces.<slug>.header` picks (its agents,
 * the people in its room, the sessions that wait on you, and the actions),
 * and the tabs sit directly under it. The first tab is always the room; the
 * tabs after it come from `spaces.<slug>.tabs`. `?tab=` deep links a tab.
 * The "+" menu and Edit tabs write the same manifest list.
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

  const tabs = visibleSpaceTabs(space, { goals: goalsOn, artifacts: artifactsOn });
  const requested = params.get('tab');
  const active = tabs.some((entry) => entry.key === requested) ? requested! : ROOM_TAB;
  const selectTab = (key: string) => {
    router.replace(key === ROOM_TAB ? pathname : `${pathname}?tab=${encodeURIComponent(key)}`);
  };

  return (
    <div className="flex h-svh flex-col overflow-hidden">
      <SpaceHeader projectId={projectId} space={space} />
      <Tabs value={active} onValueChange={selectTab} className="flex min-h-0 flex-1 flex-col gap-0">
        {/* Directly under the name, on the content's gutter (`px-5`); its rule runs edge to edge. */}
        <TabsList type="underline" className="w-full shrink-0 justify-start overflow-x-auto px-5">
          <TabsTrigger value={ROOM_TAB} className="w-fit flex-none">
            {t('tabs.room')}
          </TabsTrigger>
          {tabs.map((entry) => (
            <SpaceTabTrigger key={entry.key} value={entry.key} tab={entry.tab} />
          ))}
          {canWrite ? (
            <SpaceTabMenu projectId={projectId} space={space} onAdded={selectTab}>
              <Button size="icon-xs" variant="ghost" aria-label={t('addTab')} className="ml-1 shrink-0">
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

/**
 * The space's one header row, in the title bar: `#` and the name (the page's
 * `<h1>`), the description beside it when the row has room, then the items
 * `spaces.<slug>.header` picks, in its order. It wears the title-bar classes
 * of `ProjectPageHeader`, so it clears the desktop window controls the same
 * way. Below `@3xl` the action buttons drop their labels.
 */
function SpaceHeader({ projectId, space }: { projectId: string; space: ProjectSpace }) {
  const config = useProjectConfig(projectId);
  const sidebar = useOptionalSidebar();
  const roomsOn = useFeatureFlag(projectId, 'agent_rooms').enabled;
  // `builtin_agents.my_kortix: false` turns My Kortix off: no Ask button then.
  const items = spaceHeader(space).filter(
    (item) => item !== 'ask_my_kortix' || config?.builtin_agents?.my_kortix !== false,
  );
  const agents = agentsInSpace(space.name, config?.agents ?? []);
  const strip: ReactNode[] = [];
  for (const item of items) {
    if (item === 'agents' && agents.length) strip.push(<SpaceAgents key={item} projectId={projectId} agents={agents} />);
    if (item === 'members' && roomsOn) strip.push(<SpaceMembers key={item} projectId={projectId} slug={space.name} />);
    if (item === 'needs_you') strip.push(<SpaceNeedsYou key={item} projectId={projectId} agents={agents} />);
  }
  // The primary action sits on the trailing edge, whatever the config order.
  const actions = [
    items.includes('ask_my_kortix') ? <AskMyKortix key="ask" projectId={projectId} space={space} /> : null,
    items.includes('new_session') ? <NewSessionInSpace key="new" projectId={projectId} slug={space.name} /> : null,
  ].filter(Boolean);

  return (
    <header
      className="kx-titlebar-row kx-capability-titlebar @container/space-header relative flex shrink-0 items-center gap-1 px-2"
      data-sidebar-collapsed={sidebar?.state === 'collapsed' || undefined}
    >
      <SidebarToggle />
      <div className="kx-titlebar-tabs flex h-10 min-w-0 flex-1 items-center gap-2.5 px-3">
        <h1 className="text-foreground flex min-w-0 shrink-0 items-center gap-1 text-sm font-medium">
          <HashIcon aria-hidden className="text-muted-foreground size-4 shrink-0" />
          <span className="max-w-60 truncate">{space.label || space.name}</span>
        </h1>
        {space.description ? (
          <p className="text-muted-foreground hidden min-w-0 truncate text-xs @2xl/space-header:block">
            {space.description}
          </p>
        ) : null}
      </div>
      {strip.length || actions.length ? (
        <div className="flex shrink-0 items-center gap-3 pr-1">
          {strip}
          {actions.length ? <div className="flex items-center gap-1">{actions}</div> : null}
        </div>
      ) : null}
    </header>
  );
}

function SpaceAgents({ projectId, agents }: { projectId: string; agents: string[] }) {
  const t = useTranslations('spaces');
  return (
    <span role="group" aria-label={t('agents')} className="flex items-center -space-x-1">
      {agents.slice(0, PILE).map((name) => (
        <Link key={name} href={agentHref(projectId, name)} className="rounded-sm" aria-label={t('openAgent', { name })}>
          <AgentMark slug={name} tile={22} className="ring-background ring-2" />
        </Link>
      ))}
      {agents.length > PILE ? <PileMore count={agents.length - PILE} /> : null}
    </span>
  );
}

function PileMore({ count }: { count: number }) {
  return (
    <span className="bg-muted text-muted-foreground ring-background relative flex h-6 min-w-6 items-center justify-center rounded-sm px-1 text-xs tabular-nums ring-2">
      +{count}
    </span>
  );
}

/** The people in the space's room, as a face pile. Nothing before the room exists. */
function SpaceMembers({ projectId, slug }: { projectId: string; slug: string }) {
  const t = useTranslations('spaces');
  const room = useSpaceRoom(projectId, slug);
  const detail = useRoom(projectId, room.data?.room_id ?? null);
  const people = (detail.data?.members ?? []).filter((member) => member.kind === 'person');
  if (!people.length) return null;
  return (
    <span role="group" aria-label={t('members', { count: people.length })} className="flex items-center -space-x-1">
      {people.slice(0, PILE).map((person) => (
        <UserAvatar
          key={person.member_id}
          name={person.label}
          email={person.user_id ?? person.label}
          size="sm"
          ring
          hint={person.label}
        />
      ))}
      {people.length > PILE ? <PileMore count={people.length - PILE} /> : null}
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
    <Link href={href} className="hover:bg-hover flex h-7 items-center gap-1.5 rounded-md px-1.5 transition-colors">
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
      aria-label={t('newSession')}
      onClick={() => {
        // The project home with the space active: the composer starts only this space's agents.
        setActive(slug);
        router.push(uiRoutes().project(projectId));
      }}
    >
      <PlusIcon />
      <span className="hidden @3xl/space-header:inline">{t('newSession')}</span>
    </Button>
  );
}

function AskMyKortix({ projectId, space }: { projectId: string; space: ProjectSpace }) {
  const t = useTranslations('spaces');
  const configure = useConfigureThread(projectId);
  return (
    <Button
      size="sm"
      variant="ghost"
      aria-label={t('askMyKortix')}
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
      <span className="hidden @3xl/space-header:inline">{t('askMyKortix')}</span>
    </Button>
  );
}

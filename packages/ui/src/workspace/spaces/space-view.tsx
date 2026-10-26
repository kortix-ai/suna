'use client';

import { ApiError, type ProjectSession, type ProjectSpace } from '@kortix/sdk';
import {
  updateCachedProjectSessions,
  useOpenProjectDm,
  useProjectConfig,
  useProjectSpaces,
  useSession,
  useSessionPrompts,
  useProjectSpaceMembers,
  useUpdateProjectSpace,
  useVisibleAgents,
} from '@kortix/sdk/react';
import { CaretDownIcon, SquaresFourIcon } from '@phosphor-icons/react';
import { useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useTranslations } from '../../i18n';
import { Close } from '../../icons/close';
import { AgentMark } from '../../internal/components/agent-mark';
import { SidebarToggle } from '../../internal/layout/sidebar-toggle';
import { MemoryView } from '../memory/memory-view';
import { UsedMemoryChip } from '../memory/used-memory-chip';
import { useIsPhone } from '../../hooks/use-mobile';
import { PROJECT_ACTIONS } from '../../internal/lib/project-actions';
import { type CanResult, useProjectCan, useProjectPageCans } from '../../internal/lib/use-project-can';
import { ProjectScope } from '../../internal/project-scope';
import { useComposerPrefillStore } from '../../internal/stores/composer-prefill-store';
import { cn } from '../../lib/utils';
import { uiRoutes } from '../../lib/routes';
import { Button } from '../../primitives/button';
import { ConfirmDialog } from '../../primitives/confirm-dialog';
import { EmptyArt } from '../../primitives/empty-art';
import { EmptyState } from '../../primitives/empty-state';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '../../primitives/resizable';
import { ErrorState } from '../../primitives/error-state';
import Hint from '../../primitives/hint';
import { useOptionalSidebar } from '../../primitives/sidebar';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../primitives/tabs';
import { errorToast, successToast } from '../../primitives/toast';
import { UiLink as Link, useUiPathname, useUiRouter, useUiSearchParams } from '../../providers/ui-provider';
import { ComposerChatInput, type ComposerOptions } from '../../session/composer/composer-chat-input';
import { FeaturedAgentsContext } from '../../session/composer/agent-selector';
import { ComposerDropZone } from '../../session/composer/composer-drop-zone';
import type { DraftScope } from '../../session/composer/draft/composer-draft';
import { AfterFirstPromptContext } from '../../session/thread/after-first-prompt';
import { SessionThread } from '../../session/thread/session-thread';
import { TranscriptRowsContext } from '../../session/thread/transcript-rows';
import { useProjectHomeSend } from '../layout/use-project-home-send';
import { ChannelSetup } from './channel-setup';
import { ChannelsIntro, GeneralChatHead } from './channels-onboarding';
import { CreateChannelDialog } from './create-channel-dialog';
import { channelRunnableAgents, offeredChannelAgents } from './space-agents';
import { SpaceLinks } from './space-links';
import { SpaceTriggers } from './space-triggers';
import { SpaceDetailsDialog, type SpaceDetailsTab } from './space-details-dialog';
import { ChannelGlyph } from './channel-glyph';
import { JoinChannelButton } from './space-members';
import { SpaceRosterButton } from './space-roster';
import {
  agentLabel,
  liveReplyCount,
  spaceRoster,
  spaceTabFromParam,
  spaceTabs,
  threadIsWorking,
  type SpaceTab,
} from './space-timeline';
import { SpaceTimeline, useSpaceThreads, type SpaceThreads } from './space-timeline-view';
import { SpaceThreadsTab } from './space-threads-tab';

/** The search and filter keys of the Threads and Links tabs. */
const TAB_FILTER_PARAMS = ['q', 'status', 'by', 'agent', 'active', 'pinned', 'added'] as const;

/** A channel by slug, or the caller's DM with one agent. */
export type SpaceTarget = { kind: 'channel'; slug: string } | { kind: 'dm'; agentName: string };

export interface SpaceViewProps {
  projectId: string;
  target: SpaceTarget;
  /** Runs first on every send. Throw to refuse it: the composer keeps the draft (apps/web checks billing here). */
  beforeSend?: () => Promise<void>;
  /**
   * The Files tab: the host's Drive folder view for the space (apps/web
   * passes its Drive explorer). Absent: the tab shows its empty state. The
   * Memory tab is the space's memory pages (`MemoryView`).
   */
  renderFolder?: (folder: SpaceFolder) => ReactNode;
  /** A channel's Apps tab: the host's App gallery for the channel. Absent: its empty state. */
  renderApps?: (space: ProjectSpace) => ReactNode;
}

/** What a host's folder view draws: one space's Files tab. `place` is "#general" or the DM's agent. */
export interface SpaceFolder {
  space: ProjectSpace;
  tab: 'files' | 'memory';
  place: string;
}

/** The query key of the open thread: it survives a reload and can be linked. */
const THREAD_PARAM = 'thread';
/** The open tab. Absent on Chat. */
const TAB_PARAM = 'tab';
/** Set by the archive action and by the create dialog's "already exists" link: the archived channel's id. */
const ARCHIVED_PARAM = 'archived';
/** `1` when the viewer may not unarchive that channel (the create dialog's 409 said `can_edit: false`). */
const ARCHIVED_LOCKED_PARAM = 'locked';

/**
 * The space's tabs, less Apps and Triggers for a caller known to lack their
 * read permission: those lists would answer 403. Shown while the answer loads.
 */
function useReadableSpaceTabs(projectId: string, kind: 'channel' | 'dm'): readonly SpaceTab[] {
  const triggers = useProjectPageCans(projectId)[PROJECT_ACTIONS.PROJECT_TRIGGER_READ];
  const apps = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_APP_READ);
  const denied = (can: CanResult | undefined) => !!can && !can.isLoading && !can.isError && !can.allowed;
  const hideApps = denied(apps);
  const hideTriggers = denied(triggers);
  return useMemo(
    () => spaceTabs(kind).filter((tab) => !(tab === 'apps' && hideApps) && !(tab === 'triggers' && hideTriggers)),
    [kind, hideApps, hideTriggers],
  );
}

/**
 * A channel or DM page under `project_channels`: the header, the tab row
 * (Chat, Threads, and the space's files, memory, apps, links and triggers),
 * and the open thread in a panel on the right. Every message starts a new
 * thread.
 */
export function SpaceView(props: SpaceViewProps) {
  return (
    <ProjectScope projectId={props.projectId}>
      {/* The project frame has no definite height (the sidebar wrapper is
          `min-h-svh`), so an in-flow page grows it by its content and the
          window scrolls: the composer lands below the fold. Out of flow, the
          view takes exactly the frame's box (the rooms layout does the same). */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div className="absolute inset-0 flex flex-col">
          <SpaceViewBody {...props} />
        </div>
        <ChannelsIntro projectId={props.projectId} />
      </div>
    </ProjectScope>
  );
}

function SpaceViewBody({ projectId, target, beforeSend, renderFolder, renderApps }: SpaceViewProps) {
  const t = useTranslations('spaces.view');
  const router = useUiRouter();
  const pathname = useUiPathname();
  const searchParams = useUiSearchParams();
  const spaces = useProjectSpaces(projectId);
  const openDm = useOpenProjectDm(projectId);

  const channel =
    target.kind === 'channel'
      ? spaces.data?.find((space) => space.kind === 'channel' && space.slug === target.slug)
      : undefined;
  const listedDm =
    target.kind === 'dm'
      ? spaces.data?.find((space) => space.kind === 'dm' && space.dm_agent_name === target.agentName)
      : undefined;
  const openedDm =
    target.kind === 'dm' && openDm.data?.dm_agent_name === target.agentName ? openDm.data : undefined;
  const space = channel ?? listedDm ?? openedDm;

  // A DM the caller never opened does not exist yet: create it once.
  const dmAgent = target.kind === 'dm' ? target.agentName : null;
  const requestedDm = useRef<string | null>(null);
  const { mutate: openDmMutate } = openDm;
  useEffect(() => {
    if (!dmAgent || !spaces.data || listedDm || requestedDm.current === dmAgent) return;
    requestedDm.current = dmAgent;
    openDmMutate(dmAgent);
  }, [dmAgent, spaces.data, listedDm, openDmMutate]);

  const threads = useSpaceThreads(projectId, space?.space_id);
  const threadId = searchParams.get(THREAD_PARAM);
  const tabs = useReadableSpaceTabs(projectId, target.kind);
  const requestedTab = spaceTabFromParam(searchParams.get(TAB_PARAM), target.kind);
  const tab = tabs.includes(requestedTab) ? requestedTab : 'chat';
  // `push` adds a history entry, so the browser's Back walks it: a tab, and
  // opening the thread panel. Filters and switching threads replace the entry.
  const setParams = useCallback(
    (change: (params: URLSearchParams) => void, mode: 'push' | 'replace' = 'replace') => {
      const params = new URLSearchParams(searchParams);
      change(params);
      const query = params.toString();
      router[mode](query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams],
  );
  // The current history entry is the one this view pushed to open the thread:
  // closing goes Back to the entry under it. A reload, a link or a later tab
  // push makes it someone else's entry, so closing replaces it instead.
  const ownThreadEntry = useRef(false);
  useEffect(() => {
    if (!threadId) ownThreadEntry.current = false;
  }, [threadId]);
  const openThread = useCallback(
    (sessionId: string) => {
      if (threadId) return setParams((params) => params.set(THREAD_PARAM, sessionId));
      ownThreadEntry.current = true;
      setParams((params) => params.set(THREAD_PARAM, sessionId), 'push');
    },
    [setParams, threadId],
  );
  const closeThread = useCallback(() => {
    if (ownThreadEntry.current) {
      ownThreadEntry.current = false;
      return router.back();
    }
    setParams((params) => params.delete(THREAD_PARAM));
  }, [router, setParams]);
  const setTab = useCallback(
    (next: string) => {
      ownThreadEntry.current = false;
      setParams((params) => {
        // Threads and Links share `q` and `by`: a tab starts unfiltered.
        for (const key of TAB_FILTER_PARAMS) params.delete(key);
        if (next === 'chat') params.delete(TAB_PARAM);
        else params.set(TAB_PARAM, next);
      }, 'push');
    },
    [setParams],
  );

  const title = target.kind === 'channel' ? target.slug : agentLabel(target.agentName);
  // The channel details dialog: the header opens it, and so does the setup block for a viewer who may add no one.
  const [details, setDetails] = useState<SpaceDetailsTab | null>(null);
  const header = (
    <SpaceHeader
      projectId={projectId}
      target={target}
      title={title}
      space={space}
      sessions={threads.sessions}
      details={details}
      setDetails={setDetails}
    />
  );

  if (!space) {
    let body = null;
    if (spaces.isError && !spaces.data) {
      body = (
        <ErrorState
          size="sm"
          title={t('loadError')}
          action={
            <Button variant="outline" size="sm" onClick={() => spaces.refetch()}>
              {t('retry')}
            </Button>
          }
        />
      );
    } else if (target.kind === 'dm' && openDm.isError) {
      body = (
        <ErrorState
          size="sm"
          title={t('dmFailed')}
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => openDm.mutate(target.agentName)}
              disabled={openDm.isPending}
            >
              {t('retry')}
            </Button>
          }
        />
      );
    } else if (target.kind === 'channel' && spaces.data) {
      const archivedId = searchParams.get(ARCHIVED_PARAM);
      const fallback = spaces.data.find((candidate) => candidate.is_default);
      body = archivedId ? (
        <ArchivedChannel
          projectId={projectId}
          slug={target.slug}
          spaceId={archivedId}
          canEdit={searchParams.get(ARCHIVED_LOCKED_PARAM) !== '1'}
        />
      ) : (
        <EmptyState
          size="sm"
          title={t('notFound')}
          description={t('notFoundHint')}
          action={
            fallback?.slug ? (
              <Button asChild variant="outline" size="sm">
                <Link href={uiRoutes().channel(projectId, fallback.slug)}>
                  {t('openDefault', { name: fallback.slug })}
                </Link>
              </Button>
            ) : null
          }
        />
      );
    }
    // Still loading: the header from the URL, an empty body (navigation shows no skeleton).
    return (
      <div className="bg-background flex min-h-0 flex-1 flex-col overflow-hidden">
        {header}
        <div className="flex min-h-0 flex-1 items-center justify-center px-5 py-8">{body}</div>
      </div>
    );
  }

  const place = space.kind === 'channel' ? `#${space.slug}` : title;
  return (
    // One panel group, always mounted, so opening a thread never remounts the
    // timeline (its scroll and the composer's draft stay). The thread joins
    // the group while one is open; the divider drags, and `autoSaveId` keeps
    // the width per browser. Below `xl` the thread takes the whole width: the
    // timeline panel and the divider hide, and the thread panel's flex-grow
    // fills the row.
    <ResizablePanelGroup
      direction="horizontal"
      autoSaveId="kortix:space-thread-split"
      className="bg-background min-h-0 flex-1 overflow-hidden"
    >
      <ResizablePanel
        id="space-timeline"
        order={1}
        minSize={35}
        defaultSize={60}
        className={cn('flex min-w-0 flex-col', threadId && 'max-xl:hidden')}
      >
        <ComposerDropZone className="flex min-h-0 min-w-0 flex-1 flex-col">
          {header}
          <Tabs value={tab} onValueChange={setTab} className="min-h-0 flex-1 gap-0">
            <TabsList type="underline" size="sm" className="w-full shrink-0 justify-start gap-4 overflow-x-auto px-5">
              {tabs.map((value) => (
                <TabsTrigger key={value} value={value} className="w-fit flex-none">
                  {t(`tab.${value}`)}
                </TabsTrigger>
              ))}
            </TabsList>
            <SpaceTabs
              projectId={projectId}
              space={space}
              place={place}
              threads={threads}
              threadId={threadId}
              onOpenThread={openThread}
              onOpenMembers={() => setDetails('members')}
              beforeSend={beforeSend}
              renderFolder={renderFolder}
              renderApps={renderApps}
              tabs={tabs}
              params={searchParams}
              setParams={setParams}
            />
          </Tabs>
        </ComposerDropZone>
      </ResizablePanel>
      {threadId ? (
        <>
          {/* A 1px hairline with a 12px hit strip (`after:`), so the panels
              stay flush; hover and drag light the app's resize seam. */}
          <ResizableHandle className="bg-border w-px after:absolute after:inset-y-0 after:-left-1.5 after:w-3 max-xl:hidden" />
          <ResizablePanel id="space-thread" order={2} minSize={25} maxSize={65} defaultSize={40} className="flex min-w-0 flex-col">
            <ThreadPanel
              key={threadId}
              projectId={projectId}
              sessionId={threadId}
              context={place}
              thread={threads.sessions.find((session) => session.session_id === threadId)}
              agentFallback={space.dm_agent_name}
              onClose={closeThread}
            />
          </ResizablePanel>
        </>
      ) : null}
    </ResizablePanelGroup>
  );
}

/**
 * The tab panels. Chat and Threads read the space's threads; Files is the
 * host's folder view, Memory the space's memory pages, Apps the host's App
 * gallery, Links the channel's links, Triggers the triggers that post here.
 * Files without a host view draws its empty state with the action disabled.
 */
function SpaceTabs({
  projectId,
  space,
  place,
  threads,
  threadId,
  onOpenThread,
  onOpenMembers,
  beforeSend,
  renderFolder,
  renderApps,
  tabs,
  params,
  setParams,
}: {
  projectId: string;
  space: ProjectSpace;
  /** "#general", or the DM's agent. */
  place: string;
  tabs: readonly SpaceTab[];
  threads: SpaceThreads;
  threadId: string | null;
  onOpenThread: (sessionId: string) => void;
  onOpenMembers: () => void;
  beforeSend?: () => Promise<void>;
  renderFolder?: (folder: SpaceFolder) => ReactNode;
  renderApps?: (space: ProjectSpace) => ReactNode;
  /** The page's query: the Threads tab keeps its search and filters there. */
  params: { get(name: string): string | null };
  setParams: (change: (params: URLSearchParams) => void) => void;
}) {
  const t = useTranslations('spaces.view');
  return (
    <>
      <TabsContent value="chat" className="flex min-h-0 flex-col">
        {space.is_default ? <GeneralChatHead projectId={projectId} /> : null}
        {space.kind === 'channel' ? <ChannelSetup projectId={projectId} space={space} onOpenMembers={onOpenMembers} /> : null}
        <SpaceTimeline projectId={projectId} space={space} threads={threads} selectedId={threadId} onOpenThread={onOpenThread} />
        <SpaceComposer projectId={projectId} space={space} onOpenThread={onOpenThread} beforeSend={beforeSend} />
      </TabsContent>
      <TabsContent value="threads" className="flex min-h-0 flex-col">
        <SpaceThreadsTab
          projectId={projectId}
          space={space}
          threads={threads}
          selectedId={threadId}
          onOpenThread={onOpenThread}
          params={params}
          setParams={setParams}
        />
      </TabsContent>
      {tabs
        .filter((tab): tab is Exclude<SpaceTab, 'chat' | 'threads'> => tab !== 'chat' && tab !== 'threads')
        .map((tab) =>
          tab === 'memory' ? (
            <TabsContent key={tab} value={tab} className="flex min-h-0 flex-col">
              <MemoryView projectId={projectId} layerKey={space.space_id} place={place} />
            </TabsContent>
          ) : renderFolder && tab === 'files' ? (
            <TabsContent key={tab} value={tab} className="flex min-h-0 flex-col">
              {renderFolder({ space, tab, place })}
            </TabsContent>
          ) : tab === 'links' ? (
            <TabsContent key={tab} value={tab} className="flex min-h-0 flex-col">
              <SpaceLinks
                projectId={projectId}
                space={space}
                place={place}
                onOpenThread={onOpenThread}
                params={params}
                setParams={setParams}
              />
            </TabsContent>
          ) : tab === 'triggers' ? (
            <TabsContent key={tab} value={tab} className="min-h-0 overflow-y-auto">
              <SpaceTriggers projectId={projectId} space={space} place={place} />
            </TabsContent>
          ) : tab === 'apps' ? (
            <TabsContent key={tab} value={tab} className="min-h-0 overflow-y-auto">
              {renderApps?.(space) ?? (
                <EmptyState
                  className="min-h-full"
                  media={<EmptyArt icon={SquaresFourIcon} />}
                  title={t('empty.apps.title')}
                  description={t('empty.apps.description', { place })}
                />
              )}
            </TabsContent>
          ) : (
            <TabsContent key={tab} value={tab} className="min-h-0 overflow-y-auto">
              <EmptyState
                className="min-h-full"
                media={<EmptyArt />}
                title={t(`empty.${tab}.title`)}
                description={t(`empty.${tab}.description`, { place })}
                action={
                  <Button variant="outline" size="sm" disabled>
                    {t(`empty.${tab}.action`)}
                  </Button>
                }
              />
            </TabsContent>
          ),
        )}
    </>
  );
}

/**
 * The header row: `# name ⌄` (the channel's details) and its description,
 * then its members and agents; a DM shows its agent. Same
 * title-bar classes as `ProjectPageHeader`, so it clears the desktop window
 * controls the same way.
 */
function SpaceHeader({
  projectId,
  target,
  title,
  space,
  sessions,
  details,
  setDetails,
}: {
  projectId: string;
  target: SpaceTarget;
  title: string;
  space: ProjectSpace | undefined;
  sessions: readonly ProjectSession[];
  details: SpaceDetailsTab | null;
  setDetails: (tab: SpaceDetailsTab | null) => void;
}) {
  const t = useTranslations('spaces.view');
  const sidebar = useOptionalSidebar();
  const router = useUiRouter();
  const update = useUpdateProjectSpace(projectId);
  const [renameOpen, setRenameOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const channel = target.kind === 'channel' && space ? space : null;
  // The channel's members and its agent list: the same roster for every
  // viewer. The threads a viewer can load only add their thread counts.
  const members = useProjectSpaceMembers(projectId, channel?.space_id);
  const roster = useMemo(() => {
    const found = spaceRoster(sessions, space?.dm_agent_name);
    const threads = new Map(found.people.map((person) => [person.id, person.threads]));
    const people = (members.data?.members ?? []).map((member) => ({
      id: member.user_id,
      name: member.name,
      email: null,
      avatarUrl: member.avatar_url,
      threads: threads.get(member.user_id) ?? 0,
    }));
    return { people, agents: space?.agents ?? [], agentThreads: found.agentThreads };
  }, [sessions, space?.dm_agent_name, space?.agents, members.data]);

  const archive = () => {
    if (!channel) return;
    update.mutate(
      { spaceId: channel.space_id, input: { archived: true } },
      {
        onSuccess: () => {
          setArchiveOpen(false);
          successToast(t('archived'));
          // The page stays on the channel, now archived, with its Unarchive action.
          router.replace(
            `${uiRoutes().channel(projectId, channel.slug ?? title)}?${ARCHIVED_PARAM}=${encodeURIComponent(channel.space_id)}`,
          );
        },
        onError: () => errorToast(t('archiveFailed')),
      },
    );
  };

  return (
    <div
      className="kx-titlebar-row kx-capability-titlebar relative flex shrink-0 items-center gap-2 px-2"
      data-sidebar-collapsed={sidebar?.state === 'collapsed' || undefined}
    >
      <SidebarToggle />
      <div className="kx-titlebar-tabs flex h-12 min-w-0 flex-1 items-center gap-2">
        {target.kind === 'channel' ? (
          <h1 className="flex min-w-0 shrink-0">
            {channel ? (
              // `#name` reads as one token, the caret as a separate affordance:
              // 2px between `#` and the name, 6px before the caret. The `#` is
              // bold at `size-4.5`, so its strokes match the 600 name and its
              // height matches the name's cap height. `has-[>svg]:px-1.5`, not
              // `px-*`: the `sm` size's own `has-[>svg]:px-2.5` would win.
              <Button
                variant="ghost"
                size="sm"
                className="max-w-60 gap-0 has-[>svg]:px-1.5"
                aria-label={t('channelDetails', { name: title })}
                onClick={() => setDetails('about')}
              >
                <ChannelGlyph visibility={channel.visibility} weight="bold" className="size-4.5 shrink-0" />
                <span className="ml-0.5 truncate text-lg font-semibold">{title}</span>
                <CaretDownIcon weight="bold" className="text-muted-foreground ml-1.5 size-3.5 shrink-0" />
              </Button>
            ) : (
              <span className="flex h-8 items-center px-1.5">
                <ChannelGlyph weight="bold" className="size-4.5 shrink-0" />
                <span className="ml-0.5 truncate text-lg font-semibold">{title}</span>
              </span>
            )}
          </h1>
        ) : (
          <h1 className="flex min-w-0 shrink-0 items-center gap-2 px-2">
            <AgentMark slug={target.agentName} size={14} />
            <span className="truncate text-lg font-semibold">{title}</span>
          </h1>
        )}
        {channel?.description ? (
          <p className="text-muted-foreground min-w-0 truncate text-xs" title={channel.description}>
            {channel.description}
          </p>
        ) : null}
      </div>
      {channel && channel.is_member === false && channel.visibility !== 'private' ? <JoinChannelButton projectId={projectId} space={channel} /> : null}
      {channel && (roster.people.length > 0 || roster.agents.length > 0) ? (
        <SpaceRosterButton roster={roster} onViewAll={() => setDetails('members')} />
      ) : null}
      {channel ? (
        <>
          <SpaceDetailsDialog
            space={channel}
            tab={details}
            onTabChange={setDetails}
            onOpenChange={(open) => setDetails(open ? 'about' : null)}
            onEdit={() => {
              setDetails(null);
              setRenameOpen(true);
            }}
            onArchive={() => {
              setDetails(null);
              setArchiveOpen(true);
            }}
          />
          <CreateChannelDialog projectId={projectId} open={renameOpen} onOpenChange={setRenameOpen} space={channel} />
          <ConfirmDialog
            open={archiveOpen}
            onOpenChange={setArchiveOpen}
            title={t('archiveTitle', { name: title })}
            description={t('archiveDescription')}
            confirmLabel={t('archive')}
            onConfirm={archive}
            isPending={update.isPending}
          />
        </>
      ) : null}
    </div>
  );
}

/**
 * `/c/<slug>` of an archived channel whose id the link carried. Its creator or a
 * project manager (`canEdit`) may bring it back; anyone else reads who can.
 */
function ArchivedChannel({
  projectId,
  slug,
  spaceId,
  canEdit,
}: {
  projectId: string;
  slug: string;
  spaceId: string;
  canEdit: boolean;
}) {
  const t = useTranslations('spaces.view');
  const router = useUiRouter();
  const update = useUpdateProjectSpace(projectId);
  const unarchive = () =>
    update.mutate(
      { spaceId, input: { archived: false } },
      {
        onSuccess: (space) => {
          successToast(t('unarchived'));
          router.replace(uiRoutes().channel(projectId, space.slug ?? slug));
        },
        onError: (err) => errorToast(t(err instanceof ApiError && err.status === 403 ? 'archivedLocked' : 'unarchiveFailed')),
      },
    );
  if (!canEdit) {
    return <EmptyState size="sm" title={t('archivedTitle', { name: slug })} description={t('archivedLocked')} />;
  }
  return (
    <EmptyState
      size="sm"
      title={t('archivedTitle', { name: slug })}
      description={t('archivedHint')}
      action={
        <Button
          variant="outline"
          size="sm"
          onClick={unarchive}
          disabled={update.isPending}
          aria-busy={update.isPending || undefined}
        >
          {t('unarchive')}
        </Button>
      }
    />
  );
}

/**
 * The composer under the timeline. Every send creates a new thread in this
 * space (`useProjectHomeSend` with `space`): the billing gate, uploads and the
 * first prompt work as on project home, and the new thread opens on the right.
 */
function SpaceComposer({
  projectId,
  space,
  onOpenThread,
  beforeSend,
}: {
  projectId: string;
  space: ProjectSpace;
  onOpenThread: (sessionId: string) => void;
  beforeSend?: () => Promise<void>;
}) {
  const t = useTranslations('spaces.view');
  const isPhone = useIsPhone();
  const spaceSend = useMemo(() => ({ spaceId: space.space_id, onOpen: onOpenThread }), [space.space_id, onOpenThread]);
  const { send, sending } = useProjectHomeSend(projectId, { beforeSend, space: spaceSend });
  const draftScope = useMemo<DraftScope>(() => ({ kind: 'space', spaceId: space.space_id }), [space.space_id]);

  // A prompt handed to project home (`?q=`, "start in chat") lands here, since home opens the default channel.
  const pendingPrefill = useComposerPrefillStore((s) => s.prefillByProject[projectId]);
  const consumePrefill = useComposerPrefillStore((s) => s.consume);
  const [prefill, setPrefill] = useState<Parameters<typeof ComposerChatInput>[0]['prefill']>(null);
  useEffect(() => {
    if (!pendingPrefill) return;
    consumePrefill(projectId);
    setPrefill({
      text: pendingPrefill.text,
      id: Date.now(),
      submit: pendingPrefill.submit,
      files: pendingPrefill.files,
      options: pendingPrefill.options,
    });
  }, [pendingPrefill, projectId, consumePrefill]);

  const onCommand = useCallback(
    (command: { name: string }, args: string | undefined, options: ComposerOptions) => {
      // The send rejects on failure; the hook already showed the error.
      void Promise.resolve(send(`/${command.name}${args ? ` ${args}` : ''}`, undefined, options)).catch(
        () => undefined,
      );
    },
    [send],
  );

  const agent = space.dm_agent_name;
  // A channel's agents lead its picker; the first one the project still offers starts a new thread.
  const visible = useVisibleAgents({ projectId });
  const projectConfig = useProjectConfig(projectId);
  const projectDefault = projectConfig?.default_agent ?? projectConfig?.open_code_default_agent ?? null;
  // A member with no agent grant still posts here with the channel's agents.
  const runnable = useMemo(() => channelRunnableAgents(space, projectDefault), [space, projectDefault]);
  const offered = useMemo(
    () => [...visible, ...runnable.filter((name) => !visible.some((a) => a.name === name)).map((name) => ({ name }))],
    [visible, runnable],
  );
  const channelAgents = useMemo(() => offeredChannelAgents(space, offered), [space, offered]);
  const channelName = space.slug ?? space.name;
  const featured = useMemo(
    () => (channelAgents.length > 0 ? { label: `#${channelName}`, restLabel: t('allAgents'), names: channelAgents } : null),
    [channelAgents, channelName, t],
  );
  return (
    <div className="shrink-0 pt-1 pb-4">
      <FeaturedAgentsContext.Provider value={featured}>
        <ComposerChatInput
          defaultAgentName={channelAgents[0] ?? null}
          channelAgentNames={runnable}
          onSend={send}
          onCommand={onCommand}
          projectId={projectId}
          draftScope={draftScope}
          isSending={sending}
          disabled={sending}
          // The box empties at the keypress; the thread on the right draws the attachments.
          clearOnSend="text-only"
          boundAgentName={agent}
          // `hint`, not `placeholder`: a placeholder is only the first frame of
          // the rotating tips, and this box must always say where the message goes.
          hint={
            agent ? t('messageAgent', { agent: agentLabel(agent) }) : t('messageChannel', { name: space.slug ?? space.name })
          }
          prefill={prefill}
          // Attach, agent and settings inside the bordered box, down to a 720px
          // window. A phone's toolbar is too narrow beside the model selector, so
          // it keeps the row beneath.
          underbarPlacement={isPhone ? 'below' : 'inline'}
          slashMenuPlacement="above"
          // The timeline's width and side margins, not the centred session column.
          parentClassName="max-w-none px-5"
        />
      </FeaturedAgentsContext.Provider>
    </div>
  );
}

/**
 * "N replies" with a hairline to the right. At 0 (the first answer pending)
 * the hairline is drawn alone at the same place and height, and the count
 * fades in when the answer lands: the answer row never moves.
 */
function RepliesDivider({ count, className }: { count: number; className?: string }) {
  const t = useTranslations('spaces.view');
  return (
    <div className={cn('flex items-center gap-3 px-5', className)}>
      {/* At 0 the text holds "1 reply"'s width, invisible, so the line starts where it will stay. */}
      <span
        aria-hidden={count === 0 || undefined}
        className={cn(
          'text-muted-foreground shrink-0 text-xs tabular-nums transition-opacity duration-(--duration-normal) ease-out motion-reduce:transition-none',
          count === 0 && 'opacity-0',
        )}
      >
        {t('replies', { count: Math.max(count, 1) })}
      </span>
      <div className="bg-border h-px flex-1" />
    </div>
  );
}

/**
 * The open thread, beside the timeline: its header, then the session's
 * transcript drawn as message rows (`TranscriptRowsContext`) with the reply
 * composer under it. Sending continues the same session.
 */
function ThreadPanel({
  projectId,
  sessionId,
  context,
  thread,
  agentFallback,
  onClose,
}: {
  projectId: string;
  sessionId: string;
  context: string;
  /** The thread's list row, when loaded: its reply count and its author. */
  thread: ProjectSession | undefined;
  agentFallback: string | null;
  onClose: () => void;
}) {
  const t = useTranslations('spaces.view');
  const session = useSession(projectId, sessionId);
  useLiveThreadRow(projectId, sessionId, session);
  // Null from an older API that does not count replies.
  const replyCount = thread?.reply_count ?? null;
  const dividerOnTop = Boolean(replyCount) && session.hasOlder;
  const answered = session.messages.some((message) => message.info.role === 'assistant');
  // A turn has finished: the thread's "Used memory" record can be read.
  const turnDone = !session.isBusy && answered;
  // The first answer is on its way (or landed a frame before its count):
  // the divider is drawn without a count, so the answer does not push it in.
  const answerPending = replyCount === 0 && (session.isBusy || answered || (!!thread && threadIsWorking(thread)));
  // Stable across stream frames: every memoized turn reads this context.
  // "Used memory" sits under the first prompt, or heads the panel with the divider.
  const afterFirstPrompt = useMemo(
    () =>
      dividerOnTop ? null : (
        <>
          {replyCount || answerPending ? <RepliesDivider count={replyCount ?? 0} className="py-2" /> : null}
          <UsedMemoryChip projectId={projectId} sessionId={sessionId} ready={turnDone} className="px-5" />
        </>
      ),
    [replyCount, answerPending, dividerOnTop, projectId, sessionId, turnDone],
  );
  const agentName = session.agentName ?? thread?.agent_name ?? agentFallback;
  const rows = useMemo(
    () => ({
      agent: agentName ? agentLabel(agentName) : t('agentFallback'),
      agentSlug: agentName ?? undefined,
      owner: thread
        ? { name: thread.owner_name ?? null, email: thread.owner_email ?? null, avatarUrl: thread.owner_avatar_url ?? null }
        : null,
      unknownAuthor: t('authorFallback'),
      // The composer's computer notices say "thread", never "session".
      notices: {
        unreachable: t('notice.unreachable'),
        unreachableMidTurn: t('notice.unreachableMidTurn'),
        stalled: t('notice.stalled'),
        starting: t('notice.starting'),
        idle: t('notice.idle'),
        waking: t('notice.waking'),
      },
      labels: {
        restart: t('boot.restart'),
      },
    }),
    [agentName, thread, t],
  );
  return (
    <aside aria-label={t('threadTitle')} className="bg-background flex min-h-0 w-full flex-1 flex-col">
      <div className="kx-titlebar-row relative flex shrink-0 items-center gap-2 border-b px-2">
        <div className="kx-titlebar-tabs flex h-12 min-w-0 flex-1 items-center px-3">
          <div className="flex min-w-0 items-baseline gap-2">
            <h2 className="text-base font-semibold">{t('threadTitle')}</h2>
            <span className="text-muted-foreground truncate text-xs">{context}</span>
          </div>
        </div>
        <Hint label={t('closeThread')} side="bottom">
          <Button variant="ghost" size="icon-md" aria-label={t('closeThread')} onClick={onClose}>
            <Close />
          </Button>
        </Hint>
      </div>
      {/* The parent message, then "N replies", then the replies. While older
          history is not loaded, the first turn on screen is not the parent
          message, so the divider heads the panel instead. */}
      {replyCount && dividerOnTop ? (
        <div className="shrink-0 pt-3">
          <RepliesDivider count={replyCount} />
          <UsedMemoryChip projectId={projectId} sessionId={sessionId} ready={turnDone} className="px-5" />
        </div>
      ) : null}
      <TranscriptRowsContext.Provider value={rows}>
        <AfterFirstPromptContext.Provider value={afterFirstPrompt}>
          <SessionThread session={session} hideHeader composerPlaceholder={t('replyPlaceholder')} className="min-h-0 flex-1" />
        </AfterFirstPromptContext.Provider>
      </TranscriptRowsContext.Provider>
    </aside>
  );
}

/**
 * The open thread's live stream, written into its row in the space's cached
 * list: the timeline's "N replies", "Last reply" and "is working" change the
 * frame the panel does, not at the list's next poll (5 s working, 15 s idle).
 * The count needs the whole transcript (`hasOlder` false); with older history
 * unloaded only the working state is written. The poll still reconciles.
 */
function useLiveThreadRow(projectId: string, sessionId: string, session: ReturnType<typeof useSession>) {
  const queryClient = useQueryClient();
  const busy = session.isBusy;
  // A reply counts from Enter: the prompt inbox holds it (optimistically)
  // until the transcript has its message. The same query the panel's chat reads.
  const inbox = useSessionPrompts(projectId, sessionId);
  const ids = new Set(session.messages.map((message) => message.info.id));
  const waiting = inbox.prompts.filter(
    (prompt) =>
      prompt.state !== 'failed' && !ids.has(prompt.message_id) && !(prompt.wire_message_id && ids.has(prompt.wire_message_id)),
  ).length;
  const roles = [
    ...session.messages.map((message) => message.info.role),
    ...Array.from({ length: waiting }, () => 'user'),
  ];
  const replies = session.hasOlder || roles.length === 0 ? null : liveReplyCount(roles);
  // The stream has an answer: the computer is up, so a booting status is stale.
  const answered = roles.includes('assistant');
  // Sent, not yet running: the thread is working from Enter.
  const working = busy || waiting > 0;
  // Before the runtime is up the stream knows nothing: the list's own state stands.
  const live = !!session.runtimeSessionId;
  useEffect(() => {
    if (!live) return;
    updateCachedProjectSessions(queryClient, projectId, (rows) => {
      const index = rows.findIndex((row) => row.session_id === sessionId);
      const row = rows[index];
      if (!row) return rows;
      const grew = replies !== null && replies > (row.reply_count ?? 0);
      const booting = row.status === 'provisioning' || row.status === 'queued' || row.status === 'branching';
      const settle = (working || answered) && booting;
      if (!grew && !settle && (row.working?.state === 'working') === working) return rows;
      const now = new Date().toISOString();
      const next = rows.slice();
      next[index] = {
        ...row,
        ...(grew ? { reply_count: replies, updated_at: now } : {}),
        // `threadIsWorking` reads the status too: a thread the stream answers is up.
        ...(settle ? { status: 'running' as const } : {}),
        working: {
          state: working ? 'working' : 'idle',
          since: working ? (row.working?.since ?? now) : null,
          turn_token: row.working?.turn_token ?? null,
          pending_delivery: false,
        },
      };
      return next;
    });
  }, [queryClient, projectId, sessionId, live, working, replies, answered]);
}

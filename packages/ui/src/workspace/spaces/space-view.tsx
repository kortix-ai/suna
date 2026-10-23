'use client';

import { ApiError, type ProjectSession, type ProjectSpace } from '@kortix/sdk';
import {
  useOpenProjectDm,
  useProjectSpaces,
  useProjectSpaceSummary,
  useSession,
  useUpdateProjectSpace,
} from '@kortix/sdk/react';
import { CaretDownIcon, HashIcon, RobotIcon } from '@phosphor-icons/react';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useTranslations } from '../../i18n';
import { Close } from '../../icons/close';
import { SidebarToggle } from '../../internal/layout/sidebar-toggle';
import { MemoryView, useMemoryPageCount } from '../memory/memory-view';
import { UsedMemoryChip } from '../memory/used-memory-chip';
import { useIsMobile } from '../../internal/hooks';
import { PROJECT_ACTIONS } from '../../internal/lib/project-actions';
import { type CanResult, useProjectCan, useProjectPageCans } from '../../internal/lib/use-project-can';
import { ProjectScope } from '../../internal/project-scope';
import { useComposerPrefillStore } from '../../internal/stores/composer-prefill-store';
import { cn } from '../../lib/utils';
import { uiRoutes } from '../../lib/routes';
import { AvatarGroup } from '../../primitives/avatar';
import { Button } from '../../primitives/button';
import { ConfirmDialog } from '../../primitives/confirm-dialog';
import { CountBadge } from '../../primitives/count-badge';
import { EmptyState } from '../../primitives/empty-state';
import { EntityAvatar } from '../../primitives/entity-avatar';
import { ErrorState } from '../../primitives/error-state';
import Hint from '../../primitives/hint';
import { useOptionalSidebar } from '../../primitives/sidebar';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../primitives/tabs';
import { errorToast, successToast } from '../../primitives/toast';
import { UserAvatar } from '../../primitives/user-avatar';
import { UiLink as Link, useUiPathname, useUiRouter, useUiSearchParams } from '../../providers/ui-provider';
import { ComposerChatInput, type ComposerOptions } from '../../session/composer/composer-chat-input';
import { ComposerDropZone } from '../../session/composer/composer-drop-zone';
import type { DraftScope } from '../../session/composer/draft/composer-draft';
import { participantLabel } from '../../session/participants/session-participants';
import { AfterFirstPromptContext } from '../../session/thread/after-first-prompt';
import { SessionThread } from '../../session/thread/session-thread';
import { TranscriptRowsContext } from '../../session/thread/transcript-rows';
import { useProjectHomeSend } from '../layout/use-project-home-send';
import { CreateChannelDialog } from './create-channel-dialog';
import { SpaceLinks } from './space-links';
import { SpaceTriggers } from './space-triggers';
import { SpaceDetailsDialog, type SpaceDetailsTab } from './space-details-dialog';
import { agentLabel, spaceRoster, spaceTabFromParam, spaceTabs, type SpaceTab } from './space-timeline';
import { SpaceThreadList, SpaceTimeline, useSpaceThreads, type SpaceThreads } from './space-timeline-view';

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
  // The counts beside the Apps, Links and Triggers labels (a DM has Triggers only).
  const summary = useProjectSpaceSummary(projectId, space?.space_id);
  // Memory counts its pages (notes not included).
  const memoryCount = useMemoryPageCount(projectId, space?.space_id);
  const threadId = searchParams.get(THREAD_PARAM);
  const tabs = useReadableSpaceTabs(projectId, target.kind);
  const requestedTab = spaceTabFromParam(searchParams.get(TAB_PARAM), target.kind);
  const tab = tabs.includes(requestedTab) ? requestedTab : 'chat';
  const setParams = useCallback(
    (change: (params: URLSearchParams) => void) => {
      const params = new URLSearchParams(searchParams);
      change(params);
      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams],
  );
  const openThread = useCallback(
    (sessionId: string) => setParams((params) => params.set(THREAD_PARAM, sessionId)),
    [setParams],
  );
  const closeThread = useCallback(() => setParams((params) => params.delete(THREAD_PARAM)), [setParams]);
  const setTab = useCallback(
    (next: string) =>
      setParams((params) => (next === 'chat' ? params.delete(TAB_PARAM) : params.set(TAB_PARAM, next))),
    [setParams],
  );

  const title = target.kind === 'channel' ? target.slug : agentLabel(target.agentName);
  const header = (
    <SpaceHeader projectId={projectId} target={target} title={title} space={space} sessions={threads.sessions} />
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
    <div className="bg-background flex min-h-0 flex-1 overflow-hidden">
      <ComposerDropZone className={cn('flex min-w-0 flex-1 flex-col', threadId && 'max-xl:hidden')}>
        {header}
        <Tabs value={tab} onValueChange={setTab} className="min-h-0 flex-1 gap-0">
          <TabsList type="underline" size="sm" className="w-full shrink-0 justify-start gap-4 overflow-x-auto px-5">
            {tabs.map((value) => (
              <TabsTrigger key={value} value={value} className="w-fit flex-none">
                {t(`tab.${value}`)}
                {/* Apps counts the host's cards: no host gallery, no count over the empty state. */}
                {(value === 'links' || value === 'triggers' || (value === 'apps' && renderApps)) && summary.data?.[value] ? (
                  <CountBadge count={summary.data[value]} />
                ) : value === 'memory' && memoryCount ? (
                  <CountBadge count={memoryCount} />
                ) : null}
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
            beforeSend={beforeSend}
            renderFolder={renderFolder}
            renderApps={renderApps}
            tabs={tabs}
          />
        </Tabs>
      </ComposerDropZone>
      {threadId ? (
        <ThreadPanel
          key={threadId}
          projectId={projectId}
          sessionId={threadId}
          context={place}
          thread={threads.sessions.find((session) => session.session_id === threadId)}
          agentFallback={space.dm_agent_name}
          onClose={closeThread}
        />
      ) : null}
    </div>
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
  beforeSend,
  renderFolder,
  renderApps,
  tabs,
}: {
  projectId: string;
  space: ProjectSpace;
  /** "#general", or the DM's agent. */
  place: string;
  tabs: readonly SpaceTab[];
  threads: SpaceThreads;
  threadId: string | null;
  onOpenThread: (sessionId: string) => void;
  beforeSend?: () => Promise<void>;
  renderFolder?: (folder: SpaceFolder) => ReactNode;
  renderApps?: (space: ProjectSpace) => ReactNode;
}) {
  const t = useTranslations('spaces.view');
  return (
    <>
      <TabsContent value="chat" className="flex min-h-0 flex-col">
        <SpaceTimeline space={space} threads={threads} selectedId={threadId} onOpenThread={onOpenThread} />
        <SpaceComposer projectId={projectId} space={space} onOpenThread={onOpenThread} beforeSend={beforeSend} />
      </TabsContent>
      <TabsContent value="threads" className="min-h-0 overflow-y-auto">
        <SpaceThreadList threads={threads} selectedId={threadId} onOpenThread={onOpenThread} />
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
            <TabsContent key={tab} value={tab} className="min-h-0 overflow-y-auto">
              <SpaceLinks projectId={projectId} space={space} place={place} />
            </TabsContent>
          ) : tab === 'triggers' ? (
            <TabsContent key={tab} value={tab} className="min-h-0 overflow-y-auto">
              <SpaceTriggers projectId={projectId} space={space} place={place} />
            </TabsContent>
          ) : tab === 'apps' ? (
            <TabsContent key={tab} value={tab} className="min-h-0 overflow-y-auto">
              {renderApps?.(space) ?? (
                <div className="px-5 py-16">
                  <EmptyState size="sm" title={t('empty.apps.title')} description={t('empty.apps.description', { place })} />
                </div>
              )}
            </TabsContent>
          ) : (
            <TabsContent key={tab} value={tab} className="min-h-0 overflow-y-auto">
              <div className="px-5 py-16">
                <EmptyState
                  size="sm"
                  title={t(`empty.${tab}.title`)}
                  description={t(`empty.${tab}.description`, { place })}
                  action={
                    <Button variant="outline" size="sm" disabled>
                      {t(`empty.${tab}.action`)}
                    </Button>
                  }
                />
              </div>
            </TabsContent>
          ),
        )}
    </>
  );
}

/**
 * The header row: `# name ⌄` (the channel's details) and its description,
 * then the people and agents of its threads; a DM shows its agent. Same
 * title-bar classes as `ProjectPageHeader`, so it clears the desktop window
 * controls the same way.
 */
function SpaceHeader({
  projectId,
  target,
  title,
  space,
  sessions,
}: {
  projectId: string;
  target: SpaceTarget;
  title: string;
  space: ProjectSpace | undefined;
  sessions: readonly ProjectSession[];
}) {
  const t = useTranslations('spaces.view');
  const sidebar = useOptionalSidebar();
  const router = useUiRouter();
  const update = useUpdateProjectSpace(projectId);
  const [details, setDetails] = useState<SpaceDetailsTab | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const roster = useMemo(() => spaceRoster(sessions, space?.dm_agent_name), [sessions, space?.dm_agent_name]);
  const channel = target.kind === 'channel' && space ? space : null;

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
              <Button
                variant="ghost"
                size="sm"
                className="max-w-60 gap-1 px-2"
                aria-label={t('channelDetails', { name: title })}
                onClick={() => setDetails('about')}
              >
                <HashIcon className="size-4 shrink-0" />
                <span className="truncate text-lg font-semibold">{title}</span>
                <CaretDownIcon className="text-muted-foreground size-3 shrink-0" />
              </Button>
            ) : (
              <span className="flex h-8 items-center gap-1 px-2">
                <HashIcon className="size-4 shrink-0" />
                <span className="truncate text-lg font-semibold">{title}</span>
              </span>
            )}
          </h1>
        ) : (
          <h1 className="flex min-w-0 shrink-0 items-center gap-2 px-2">
            <EntityAvatar icon={RobotIcon} label={title} size="xs" />
            <span className="truncate text-lg font-semibold">{title}</span>
          </h1>
        )}
        {channel?.description ? (
          <p className="text-muted-foreground min-w-0 truncate text-xs" title={channel.description}>
            {channel.description}
          </p>
        ) : null}
      </div>
      {channel && (roster.people.length > 0 || roster.agents.length > 0) ? (
        <RosterPill roster={roster} onClick={() => setDetails('members')} />
      ) : null}
      {channel ? (
        <>
          <SpaceDetailsDialog
            space={channel}
            roster={roster}
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

/** "3 people · 2 agents" with the first faces: the people and agents of the loaded threads. */
function RosterPill({
  roster,
  onClick,
}: {
  roster: ReturnType<typeof spaceRoster>;
  onClick: () => void;
}) {
  const t = useTranslations('spaces.view');
  const label = t('roster', {
    people: t('rosterPeople', { count: roster.people.length }),
    agents: t('rosterAgents', { count: roster.agents.length }),
  });
  return (
    <Hint label={t('rosterHint')} side="bottom">
      <Button variant="outline" size="sm" className="shrink-0 gap-2 px-1.5" onClick={onClick}>
        {roster.people.length > 0 ? (
          <AvatarGroup className="-space-x-1">
            {roster.people.slice(0, 3).map((person) => (
              <UserAvatar
                key={person.id}
                email={person.email ?? ''}
                name={participantLabel(person)}
                avatarUrl={person.avatarUrl}
                size="xs"
                ring
              />
            ))}
          </AvatarGroup>
        ) : null}
        <span className="text-muted-foreground text-xs tabular-nums">{label}</span>
      </Button>
    </Hint>
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
  const isMobile = useIsMobile();
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
  return (
    <div className="shrink-0 pt-1 pb-4">
      <ComposerChatInput
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
        // Attach, agent and settings inside the bordered box. A phone's toolbar
        // is too narrow beside the model selector, so it keeps the row beneath.
        underbarPlacement={isMobile ? 'below' : 'inline'}
        slashMenuPlacement="above"
        // The timeline's width and side margins, not the centred session column.
        parentClassName="max-w-none px-5"
      />
    </div>
  );
}

/** "N replies" with a hairline to the right. */
function RepliesDivider({ count, className }: { count: number; className?: string }) {
  const t = useTranslations('spaces.view');
  return (
    <div className={cn('flex items-center gap-3 px-5', className)}>
      <span className="text-muted-foreground shrink-0 text-xs tabular-nums">{t('replies', { count })}</span>
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
  // Null from an older API that does not count replies.
  const replyCount = thread?.reply_count ?? null;
  const dividerOnTop = Boolean(replyCount) && session.hasOlder;
  // A turn has finished: the thread's "Used memory" record can be read.
  const turnDone = !session.isBusy && session.messages.some((message) => message.info.role === 'assistant');
  // Stable across stream frames: every memoized turn reads this context.
  // "Used memory" sits under the first prompt, or heads the panel with the divider.
  const afterFirstPrompt = useMemo(
    () =>
      dividerOnTop ? null : (
        <>
          {replyCount ? <RepliesDivider count={replyCount} className="py-2" /> : null}
          <UsedMemoryChip projectId={projectId} sessionId={sessionId} ready={turnDone} className="px-5" />
        </>
      ),
    [replyCount, dividerOnTop, projectId, sessionId, turnDone],
  );
  const agentName = session.agentName ?? thread?.agent_name ?? agentFallback;
  const rows = useMemo(
    () => ({
      agent: agentName ? agentLabel(agentName) : t('agentFallback'),
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
    <aside aria-label={t('threadTitle')} className="bg-background flex min-h-0 w-full flex-col xl:w-125 xl:shrink-0 xl:border-l">
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

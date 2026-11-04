'use client';

import { ApiError, type ProjectSession, type ProjectSpace } from '@kortix/sdk';
import {
  useOpenProjectDm,
  useProjectConfig,
  useProjectSpaces,
  useProjectSpaceMembers,
  useUpdateProjectSpace,
  useVisibleAgents,
} from '@kortix/sdk/react';
import { CaretDownIcon, InfoIcon } from '@phosphor-icons/react';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useTranslations } from '../../i18n';
import { AgentMark } from '../../internal/components/agent-mark';
import { SidebarToggle } from '../../internal/layout/sidebar-toggle';
import { useIsPhone } from '../../hooks/use-mobile';
import { ProjectScope } from '../../internal/project-scope';
import { useComposerPrefillStore } from '../../internal/stores/composer-prefill-store';
import { uiRoutes } from '../../lib/routes';
import { Button } from '../../primitives/button';
import { ConfirmDialog } from '../../primitives/confirm-dialog';
import { EmptyState } from '../../primitives/empty-state';
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
import { useProjectHomeSend } from '../layout/use-project-home-send';
import { CreateChannelDialog } from './create-channel-dialog';
import { channelRunnableAgents, offeredChannelAgents } from './space-agents';
import { SpaceDetailsDialog, type SpaceDetailsTab, type SpaceFolder } from './space-details-dialog';
import { ChannelGlyph } from './channel-glyph';
import { JoinChannelButton } from './space-members';
import { SpaceRosterButton } from './space-roster';
import { agentLabel, spaceRoster, spaceTabFromParam, spaceTabs } from './space-timeline';
import { SpaceTimeline, useSpaceThreads } from './space-timeline-view';
import { SpaceThreadsTab } from './space-threads-tab';

/** The search and filter keys of the Sessions tab. */
const TAB_FILTER_PARAMS = ['q', 'status', 'by', 'agent', 'active'] as const;

/** A channel by slug, or the caller's DM with one agent. */
export type SpaceTarget = { kind: 'channel'; slug: string } | { kind: 'dm'; agentName: string };

export interface SpaceViewProps {
  projectId: string;
  target: SpaceTarget;
  /** Runs first on every send. Throw to refuse it: the composer keeps the draft (apps/web checks billing here). */
  beforeSend?: () => Promise<void>;
  /**
   * The space's folder in Details → Files: the host's Drive folder view
   * (apps/web passes its Drive explorer). Absent: Details has no Files tab.
   */
  renderFolder?: (folder: SpaceFolder) => ReactNode;
}

export type { SpaceFolder };

/**
 * A link written before sessions opened on their own page (`?thread=<id>`).
 * The page forwards it to the session.
 */
const LEGACY_SESSION_PARAM = 'thread';
/** The open tab. Absent on Conversation. */
const TAB_PARAM = 'tab';
/** Set by the archive action and by the create dialog's "already exists" link: the archived channel's id. */
const ARCHIVED_PARAM = 'archived';
/** `1` when the viewer may not unarchive that channel (the create dialog's 409 said `can_edit: false`). */
const ARCHIVED_LOCKED_PARAM = 'locked';

/**
 * A channel or DM page under `project_channels`: the header, two tabs
 * (Conversation and Sessions), and one composer. Every message starts a new
 * session filed in this space. A session opens on its own page, where its
 * work, Browser and Terminal live and where a reply continues it. The space's
 * memory, links and folder are in Details.
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

function SpaceViewBody({ projectId, target, beforeSend, renderFolder }: SpaceViewProps) {
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
  const tabs = spaceTabs(target.kind);
  const tab = spaceTabFromParam(searchParams.get(TAB_PARAM), target.kind);
  const setParams = useCallback(
    (change: (params: URLSearchParams) => void, mode: 'push' | 'replace' = 'replace') => {
      const params = new URLSearchParams(searchParams);
      change(params);
      const query = params.toString();
      router[mode](query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams],
  );
  // A session opens on its own page: the full work, Browser and Terminal, and
  // its composer for a reply. Its header links back to this space.
  const openSession = useCallback(
    (sessionId: string) => router.push(uiRoutes().session(projectId, sessionId)),
    [projectId, router],
  );
  // An old `?thread=<id>` link lands on that session's page.
  const legacySessionId = searchParams.get(LEGACY_SESSION_PARAM);
  useEffect(() => {
    if (legacySessionId) router.replace(uiRoutes().session(projectId, legacySessionId));
  }, [legacySessionId, projectId, router]);
  const setTab = useCallback(
    (next: string) => {
      setParams((params) => {
        // A tab starts unfiltered.
        for (const key of TAB_FILTER_PARAMS) params.delete(key);
        if (next === 'chat') params.delete(TAB_PARAM);
        else params.set(TAB_PARAM, next);
      }, 'push');
    },
    [setParams],
  );

  const title = target.kind === 'channel' ? target.slug : agentLabel(target.agentName);
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
      renderFolder={renderFolder}
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

  return (
    <ComposerDropZone className="bg-background flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {header}
      <Tabs value={tab} onValueChange={setTab} className="min-h-0 flex-1 gap-0">
        <TabsList type="underline" size="sm" className="w-full shrink-0 justify-start gap-4 overflow-x-auto px-5">
          {tabs.map((value) => (
            <TabsTrigger key={value} value={value} className="w-fit flex-none">
              {t(`tab.${value}`)}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="chat" className="flex min-h-0 flex-col">
          <SpaceTimeline projectId={projectId} space={space} threads={threads} selectedId={null} onOpenThread={openSession} />
          <SpaceComposer projectId={projectId} space={space} beforeSend={beforeSend} />
        </TabsContent>
        <TabsContent value="sessions" className="flex min-h-0 flex-col">
          <SpaceThreadsTab
            projectId={projectId}
            space={space}
            threads={threads}
            selectedId={null}
            onOpenThread={openSession}
            params={searchParams}
            setParams={setParams}
          />
        </TabsContent>
      </Tabs>
    </ComposerDropZone>
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
  renderFolder,
}: {
  projectId: string;
  target: SpaceTarget;
  title: string;
  space: ProjectSpace | undefined;
  sessions: readonly ProjectSession[];
  details: SpaceDetailsTab | null;
  setDetails: (tab: SpaceDetailsTab | null) => void;
  renderFolder?: (folder: SpaceFolder) => ReactNode;
}) {
  const t = useTranslations('spaces.view');
  const sidebar = useOptionalSidebar();
  const router = useUiRouter();
  const update = useUpdateProjectSpace(projectId);
  const [renameOpen, setRenameOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const channel = target.kind === 'channel' && space ? space : null;
  // The channel's members and its agent list: the same roster for every
  // viewer. The sessions a viewer can load only add their session counts.
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
      {space && !channel ? (
        // A DM's details: what the agent remembers about you, and its folder.
        <Hint label={t('dmDetails', { agent: title })} side="bottom">
          <Button variant="ghost" size="icon-md" aria-label={t('dmDetails', { agent: title })} onClick={() => setDetails('memory')}>
            <InfoIcon />
          </Button>
        </Hint>
      ) : null}
      {space && !channel ? (
        <SpaceDetailsDialog
          space={space}
          title={title}
          tab={details}
          onTabChange={setDetails}
          onOpenChange={(open) => setDetails(open ? 'memory' : null)}
          onEdit={() => undefined}
          onArchive={() => undefined}
          renderFolder={renderFolder}
        />
      ) : null}
      {channel ? (
        <>
          <SpaceDetailsDialog
            space={channel}
            title={title}
            tab={details}
            onTabChange={setDetails}
            onOpenChange={(open) => setDetails(open ? 'about' : null)}
            renderFolder={renderFolder}
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
 * The one composer on the page, under the timeline. Every send creates a new
 * session in this space (`useProjectHomeSend` with `space`): the billing gate,
 * uploads and the first prompt work as on project home.
 */
function SpaceComposer({
  projectId,
  space,
  beforeSend,
}: {
  projectId: string;
  space: ProjectSpace;
  beforeSend?: () => Promise<void>;
}) {
  const t = useTranslations('spaces.view');
  const isPhone = useIsPhone();
  // The page stays on the conversation: the new session's row lands at the
  // bottom of the timeline and shows the answer when the turn ends.
  const spaceSend = useMemo(() => ({ spaceId: space.space_id, onOpen: () => undefined }), [space.space_id]);
  const { send, sending } = useProjectHomeSend(projectId, { beforeSend, space: spaceSend });
  const draftScope = useMemo<DraftScope>(() => ({ kind: 'space', spaceId: space.space_id }), [space.space_id]);

  // A prompt handed to this space's composer through the prefill store lands here.
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
  // A channel's agents lead its picker; the first one the project still offers starts a new session.
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
          // The box empties at the keypress; the new session's row draws the message.
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

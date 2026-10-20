'use client';

import type { ProjectSpace } from '@kortix/sdk';
import { useOpenProjectDm, useProjectSpaces, useSession, useUpdateProjectSpace } from '@kortix/sdk/react';
import { CaretDownIcon, HashIcon, RobotIcon } from '@phosphor-icons/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useTranslations } from '../../i18n';
import { Close } from '../../icons/close';
import { SidebarToggle } from '../../internal/layout/sidebar-toggle';
import { ProjectScope } from '../../internal/project-scope';
import { useComposerPrefillStore } from '../../internal/stores/composer-prefill-store';
import { cn } from '../../lib/utils';
import { uiRoutes } from '../../lib/routes';
import { Button } from '../../primitives/button';
import { ConfirmDialog } from '../../primitives/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../primitives/dropdown-menu';
import { EmptyState } from '../../primitives/empty-state';
import { EntityAvatar } from '../../primitives/entity-avatar';
import { ErrorState } from '../../primitives/error-state';
import Hint from '../../primitives/hint';
import { useOptionalSidebar } from '../../primitives/sidebar';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../primitives/tabs';
import { errorToast, successToast } from '../../primitives/toast';
import { UiLink as Link, useUiPathname, useUiRouter, useUiSearchParams } from '../../providers/ui-provider';
import { ComposerChatInput, type ComposerOptions } from '../../session/composer/composer-chat-input';
import { ComposerDropZone } from '../../session/composer/composer-drop-zone';
import type { DraftScope } from '../../session/composer/draft/composer-draft';
import { SessionThread } from '../../session/thread/session-thread';
import { useProjectHomeSend } from '../layout/use-project-home-send';
import { CreateChannelDialog } from './create-channel-dialog';
import { agentLabel } from './space-timeline';
import { SpaceThreadList, SpaceTimeline, useSpaceThreads } from './space-timeline-view';

/** A channel by slug, or the caller's DM with one agent. */
export type SpaceTarget = { kind: 'channel'; slug: string } | { kind: 'dm'; agentName: string };

export interface SpaceViewProps {
  projectId: string;
  target: SpaceTarget;
  /** Runs first on every send. Throw to refuse it: the composer keeps the draft (apps/web checks billing here). */
  beforeSend?: () => Promise<void>;
}

/** The query key of the open thread: it survives a reload and can be linked. */
const THREAD_PARAM = 'thread';
/** Set by the archive action and by the create dialog's "already exists" link: the archived channel's id. */
const ARCHIVED_PARAM = 'archived';

/**
 * A channel or DM page under `project_channels`: the header, the Chat tab (the
 * timeline of threads with the composer under it) and the Threads tab, with the
 * open thread in a panel on the right. Every message starts a new thread.
 */
export function SpaceView(props: SpaceViewProps) {
  return (
    <ProjectScope projectId={props.projectId}>
      <SpaceViewBody {...props} />
    </ProjectScope>
  );
}

function SpaceViewBody({ projectId, target, beforeSend }: SpaceViewProps) {
  const t = useTranslations('spaces.view');
  const router = useUiRouter();
  const pathname = useUiPathname();
  const searchParams = useUiSearchParams();
  const spaces = useProjectSpaces(projectId);
  const openDm = useOpenProjectDm(projectId);
  const [tab, setTab] = useState('chat');

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

  const title = target.kind === 'channel' ? target.slug : agentLabel(target.agentName);
  const header = <SpaceHeader projectId={projectId} target={target} title={title} space={space} />;

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
        <ArchivedChannel projectId={projectId} slug={target.slug} spaceId={archivedId} />
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
    <div className="bg-background flex min-h-0 flex-1 overflow-hidden">
      <ComposerDropZone
        className={cn('flex min-w-0 flex-1 flex-col', threadId && 'max-lg:hidden')}
      >
        {header}
        <Tabs value={tab} onValueChange={setTab} className="min-h-0 flex-1 gap-0">
          <TabsList type="underline" size="sm" className="w-full shrink-0 justify-start gap-4 px-5">
            <TabsTrigger value="chat" className="w-fit flex-none">
              {t('tabChat')}
            </TabsTrigger>
            <TabsTrigger value="threads" className="w-fit flex-none">
              {t('tabThreads')}
            </TabsTrigger>
          </TabsList>
          <SpaceTabs
            projectId={projectId}
            space={space}
            threads={threads}
            threadId={threadId}
            onOpenThread={openThread}
            beforeSend={beforeSend}
          />
        </Tabs>
      </ComposerDropZone>
      {threadId ? (
        <ThreadPanel
          key={threadId}
          projectId={projectId}
          sessionId={threadId}
          context={space.kind === 'channel' ? `#${space.slug}` : title}
          replyCount={threads.sessions.find((session) => session.session_id === threadId)?.reply_count ?? null}
          onClose={closeThread}
        />
      ) : null}
    </div>
  );
}

/** Both tabs read the same thread list. */
function SpaceTabs({
  projectId,
  space,
  threads,
  threadId,
  onOpenThread,
  beforeSend,
}: {
  projectId: string;
  space: ProjectSpace;
  threads: ReturnType<typeof useSpaceThreads>;
  threadId: string | null;
  onOpenThread: (sessionId: string) => void;
  beforeSend?: () => Promise<void>;
}) {
  return (
    <>
      <TabsContent value="chat" className="flex min-h-0 flex-col">
        <SpaceTimeline
          space={space}
          threads={threads}
          selectedId={threadId}
          onOpenThread={onOpenThread}
        />
        <SpaceComposer projectId={projectId} space={space} onOpenThread={onOpenThread} beforeSend={beforeSend} />
      </TabsContent>
      <TabsContent value="threads" className="min-h-0 overflow-y-auto">
        <SpaceThreadList threads={threads} selectedId={threadId} onOpenThread={onOpenThread} />
      </TabsContent>
    </>
  );
}

/**
 * The header row: `# name` with the channel menu (rename, archive), or the
 * DM's agent. Same title-bar classes as `ProjectPageHeader`, so it clears the
 * desktop window controls the same way.
 */
function SpaceHeader({
  projectId,
  target,
  title,
  space,
}: {
  projectId: string;
  target: SpaceTarget;
  title: string;
  space: ProjectSpace | undefined;
}) {
  const t = useTranslations('spaces.view');
  const sidebar = useOptionalSidebar();
  const router = useUiRouter();
  const update = useUpdateProjectSpace(projectId);
  const [renameOpen, setRenameOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const isChannel = target.kind === 'channel';

  const archive = () => {
    if (!space) return;
    update.mutate(
      { spaceId: space.space_id, input: { archived: true } },
      {
        onSuccess: () => {
          setArchiveOpen(false);
          successToast(t('archived'));
          // The page stays on the channel, now archived, with its Unarchive action.
          router.replace(
            `${uiRoutes().channel(projectId, space.slug ?? title)}?${ARCHIVED_PARAM}=${encodeURIComponent(space.space_id)}`,
          );
        },
        onError: () => errorToast(t('archiveFailed')),
      },
    );
  };

  return (
    <div
      className="kx-titlebar-row kx-capability-titlebar relative flex shrink-0 items-center gap-1 px-2"
      data-sidebar-collapsed={sidebar?.state === 'collapsed' || undefined}
    >
      <SidebarToggle />
      <div className="kx-titlebar-tabs flex h-10 min-w-0 flex-1 items-center px-1">
        {isChannel ? (
          <h1 className="min-w-0">
            {space ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="max-w-full gap-1 px-2"
                    aria-label={t('channelMenu', { name: title })}
                  >
                    <HashIcon className="text-muted-foreground size-4 shrink-0" />
                    <span className="truncate text-sm font-semibold">{title}</span>
                    <CaretDownIcon className="text-muted-foreground size-3 shrink-0" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-56">
                  <DropdownMenuItem onSelect={() => setRenameOpen(true)}>{t('rename')}</DropdownMenuItem>
                  {space.is_default ? null : (
                    <DropdownMenuItem onSelect={() => setArchiveOpen(true)}>{t('archive')}</DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <span className="flex items-center gap-1 px-2">
                <HashIcon className="text-muted-foreground size-4 shrink-0" />
                <span className="truncate text-sm font-semibold">{title}</span>
              </span>
            )}
          </h1>
        ) : (
          <h1 className="flex min-w-0 items-center gap-2 px-2">
            <EntityAvatar icon={RobotIcon} label={title} size="xs" />
            <span className="truncate text-sm font-semibold">{title}</span>
          </h1>
        )}
      </div>
      {isChannel && space ? (
        <>
          <CreateChannelDialog projectId={projectId} open={renameOpen} onOpenChange={setRenameOpen} space={space} />
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

/** `/c/<slug>` of an archived channel whose id the link carried: offer to bring it back. */
function ArchivedChannel({ projectId, slug, spaceId }: { projectId: string; slug: string; spaceId: string }) {
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
        onError: () => errorToast(t('unarchiveFailed')),
      },
    );
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
    <div className="shrink-0 px-5 pt-2 pb-4">
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
        placeholder={agent ? t('messageAgent', { agent: agentLabel(agent) }) : t('messageChannel', { name: space.slug ?? space.name })}
        prefill={prefill}
        underbarPlacement="below"
        slashMenuPlacement="above"
      />
    </div>
  );
}

/** The open thread, beside the timeline: its header and the whole thread with its own reply composer. */
function ThreadPanel({
  projectId,
  sessionId,
  context,
  replyCount,
  onClose,
}: {
  projectId: string;
  sessionId: string;
  context: string;
  /** From the thread's list row; null when the API does not count (an older API). */
  replyCount: number | null;
  onClose: () => void;
}) {
  const t = useTranslations('spaces.view');
  const session = useSession(projectId, sessionId);
  return (
    <aside
      aria-label={t('threadTitle')}
      className="bg-background flex min-h-0 w-full flex-col lg:w-125 lg:shrink-0 lg:border-l"
    >
      <div className="kx-titlebar-row relative flex shrink-0 items-center gap-1 border-b px-2">
        <div className="kx-titlebar-tabs flex h-10 min-w-0 flex-1 items-center gap-2 px-2">
          <h2 className="text-sm font-semibold">{t('threadTitle')}</h2>
          <span className="text-muted-foreground truncate text-xs">{context}</span>
        </div>
        <Hint label={t('closeThread')} side="bottom">
          <Button variant="ghost" size="icon-sm" aria-label={t('closeThread')} onClick={onClose}>
            <Close />
          </Button>
        </Hint>
      </div>
      {replyCount ? (
        // "N replies" with a hairline to the right: the transcript below holds the first prompt and its replies.
        <div className="flex shrink-0 items-center gap-3 px-4 pt-3">
          <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
            {t('replies', { count: replyCount })}
          </span>
          <div className="bg-border h-px flex-1" />
        </div>
      ) : null}
      <SessionThread
        session={session}
        hideHeader
        composerPlaceholder={t('replyPlaceholder')}
        className="min-h-0 flex-1"
      />
    </aside>
  );
}

'use client';

import type {
  ArtifactComment,
  ArtifactCommentAnchor,
  ArtifactCommentContext,
  ArtifactCommentThread,
  ArtifactDetail,
} from '@kortix/sdk';
import type { useArtifactComments } from '@kortix/sdk/react';
import { Button } from '@kortix/ui/button';
import { ButtonGroup } from '@kortix/ui/button-group';
import { ConfirmDialog } from '@kortix/ui/confirm-dialog';
import { CountBadge } from '@kortix/ui/count-badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@kortix/ui/dropdown-menu';
import { EmptyArt } from '@kortix/ui/empty-art';
import { EmptyState } from '@kortix/ui/empty-state';
import { ErrorState } from '@kortix/ui/error-state';
import Hint from '@kortix/ui/hint';
import Loading from '@kortix/ui/loading';
import { Skeleton } from '@kortix/ui/skeleton';
import { Tabs, TabsContent, TabsListCompact, TabsTriggerCompact } from '@kortix/ui/tabs';
import { errorToast, successToast } from '@kortix/ui/toast';
import { CaretDownIcon, ChatCircleIcon, PlusIcon, XIcon } from '@phosphor-icons/react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';

import { useAuth } from '@/features/providers/auth-provider';
import { useTranslations } from '@/i18n/use-translations';
import {
  ArtifactActivityTimeline,
  type ArtifactDiscussionActivity,
} from './artifact-activity-timeline';
import { ArtifactCommentComposer, type CommentMentionOption } from './artifact-comment-composer';
import { ArtifactCommentImage } from './artifact-comment-image';
import {
  ArtifactCommentThreadView,
  type ArtifactCommentViewer,
} from './artifact-comment-thread';
import { useArtifactDiscussionPanel } from './artifact-discussion-layout';
import {
  arrivedComments,
  deliveryAgent,
  groupCommentThreads,
  serverAnswered,
  threadCounts,
  threadDeleted,
  type CommentFilter,
} from './artifact-discussion-logic';
import type { ArtifactDrawingDraft } from './artifact-drawing-draft';

const EMPTY_THREADS: ArtifactCommentThread[] = [];

interface SendRequest {
  scope: string;
  id: string;
  threadIds: string[];
  total: number;
  agent: string;
}

export interface ArtifactDiscussionSidebarProps {
  projectId: string;
  artifact: ArtifactDetail;
  comments: ReturnType<typeof useArtifactComments>;
  displayThreads?: ArtifactCommentThread[];
  context?: ArtifactCommentContext;
  contextLoading?: boolean;
  contextError?: boolean;
  onRetryContext: () => void;
  activity: ArtifactDiscussionActivity;
  focusedThreadId?: string | null;
  focusRevision?: number;
  onFocusThread: (threadId: string) => void;
  pendingAnchor?: ArtifactCommentAnchor | null;
  /**
   * The pending anchor the page itself sent (its comment shortcut). Its composer shows without
   * keyboard focus: the page can forge the key. New comment focuses it.
   */
  pageOpenedAnchor?: ArtifactCommentAnchor | null;
  pendingDrawing?: ArtifactDrawingDraft | null;
  selectionCapture?: 'idle' | 'pending' | 'failed';
  onClearAnchor: (expected?: ArtifactCommentAnchor) => void;
  readOnly?: boolean;
  onOpenVersion: (version: string) => void;
  state?: ReturnType<typeof useArtifactDiscussionState>;
  /** thread_id → pin number on an HTML page. */
  pinNumbers?: ReadonlyMap<string, number>;
}

export function useArtifactDiscussionState() {
  const [tab, setTab] = useState('comments');
  const [filter, setFilter] = useState<CommentFilter>('open');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<{ threadId: string; commentId: string } | null>(null);
  const [deleting, setDeleting] = useState<{ threadId: string; comment: ArtifactComment } | null>(
    null,
  );
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [composing, setComposing] = useState(false);
  const [sendAgent, setSendAgent] = useState<string | null>(null);
  const activeRef = useRef(new Set<string>());
  const focusedRef = useRef('');
  const latestAnchorRef = useRef<ArtifactCommentAnchor | null | undefined>(undefined);
  const latestCaptureRef = useRef<'idle' | 'pending' | 'failed'>('idle');
  const [sendRequest, setSendRequest] = useState<SendRequest | null>(null);
  const sendBatchRef = useRef<SendRequest | null>(null);
  /**
   * thread_id → the batch of a single-thread retry that got no answer from the server, so the
   * next retry to the same agent repeats it.
   */
  const threadBatchRef = useRef(new Map<string, { id: string; agent: string }>());
  return {
    tab,
    setTab,
    filter,
    setFilter,
    drafts,
    setDrafts,
    editing,
    setEditing,
    deleting,
    setDeleting,
    pending,
    setPending,
    errors,
    setErrors,
    composing,
    setComposing,
    sendAgent,
    setSendAgent,
    activeRef,
    focusedRef,
    latestAnchorRef,
    latestCaptureRef,
    sendRequest,
    setSendRequest,
    sendBatchRef,
    threadBatchRef,
  };
}

export function ArtifactDiscussionSidebar({
  projectId,
  artifact,
  comments,
  displayThreads,
  context: rawContext,
  contextLoading = false,
  contextError = false,
  onRetryContext,
  activity,
  focusedThreadId,
  focusRevision = 0,
  onFocusThread,
  pendingAnchor,
  pageOpenedAnchor,
  pendingDrawing,
  selectionCapture = 'idle',
  onClearAnchor,
  readOnly = false,
  onOpenVersion,
  state,
  pinNumbers,
}: ArtifactDiscussionSidebarProps) {
  const t = useTranslations('artifacts.discussion');
  const router = useRouter();
  const panel = useArtifactDiscussionPanel();
  const context = rawContext;
  const user = useAuth().user;
  const localState = useArtifactDiscussionState();
  const {
    tab,
    setTab,
    filter,
    setFilter,
    drafts,
    setDrafts,
    editing,
    setEditing,
    deleting,
    setDeleting,
    pending,
    setPending,
    errors,
    setErrors,
    composing,
    setComposing,
    sendAgent,
    setSendAgent,
    activeRef,
    focusedRef,
    latestAnchorRef,
    latestCaptureRef,
    sendRequest,
    setSendRequest,
    sendBatchRef,
    threadBatchRef,
  } = state ?? localState;
  const root = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const newButton = useRef<HTMLButtonElement>(null);
  const [composerFocus, setComposerFocus] = useState(0);
  // A page-opened anchor whose composer the person focused with New comment.
  const [focusedPageAnchor, setFocusedPageAnchor] = useState<ArtifactCommentAnchor | null>(null);
  const scope = `${projectId}:${artifact.artifact_id}`;
  const draftKey = (kind: string, id = '') => `${scope}:${kind}:${id}`;
  const draft = (kind: string, id = '') => drafts[draftKey(kind, id)] ?? '';
  const setDraft = (kind: string, value: string, id = '') =>
    setDrafts((current) => ({ ...current, [draftKey(kind, id)]: value }));
  const threads = displayThreads ?? comments.data ?? EMPTY_THREADS;
  const grouped = groupCommentThreads(threads, filter);
  // The viewer header counts `comments.data`; the tab and the filter count the same list.
  const counts = threadCounts(comments.data ?? threads);
  const readableVersion = context?.version.commit_id ?? context?.version.entry_version;
  const canComment = !readOnly && context?.can_comment === true && !!readableVersion;
  const agentsUnavailable = context?.agents_unavailable === true;
  const mentions = useMemo<CommentMentionOption[]>(
    () =>
      context
        ? [
            ...context.people.map((person) => ({
              key: `user:${person.user_id}`,
              kind: 'user' as const,
              label: person.name,
              token: person.token,
              avatarUrl: person.avatar_url,
            })),
            ...context.agents.map((agent) => ({
              key: agent.session_id ? `session:${agent.session_id}` : `agent:${agent.agent_name}`,
              kind: agent.session_id ? ('session' as const) : ('agent' as const),
              label: agent.name,
              token: agent.token,
            })),
          ]
        : [],
    [context],
  );
  const viewer = useMemo<ArtifactCommentViewer | undefined>(() => {
    if (!user) return undefined;
    const person = context?.people.find((candidate) => candidate.user_id === user.id);
    const meta = (user.user_metadata ?? {}) as {
      full_name?: string;
      name?: string;
      avatar_url?: string;
    };
    return {
      userId: user.id,
      name: person?.name ?? meta.full_name ?? meta.name ?? user.email ?? '',
      email: user.email ?? '',
      avatarUrl: person?.avatar_url ?? meta.avatar_url ?? null,
    };
  }, [user, context]);
  const sendAgents = useMemo(() => {
    const seen = new Set<string>();
    return (context?.agents ?? []).filter((agent) =>
      seen.has(agent.agent_name) ? false : (seen.add(agent.agent_name), true),
    );
  }, [context]);
  useEffect(() => {
    latestAnchorRef.current = pendingAnchor;
    latestCaptureRef.current = selectionCapture;
  }, [pendingAnchor, selectionCapture, latestAnchorRef, latestCaptureRef]);
  useEffect(() => {
    if (!pendingAnchor) return;
    setTab('comments');
    setFilter('open');
    // The composer stays open after the passage is discarded, for a whole-Artifact comment.
    setComposing(true);
  }, [pendingAnchor, setTab, setFilter, setComposing]);
  useEffect(() => {
    if (selectionCapture !== 'idle') setComposing(true);
  }, [selectionCapture, setComposing]);
  // On open, focus the heading when a control outside the panel opened it. A pending selection
  // focuses the composer, and a thread request focuses that thread instead.
  useEffect(() => {
    const active = document.activeElement;
    const requested =
      !!focusedThreadId &&
      focusedRef.current !== `${scope}:${focusedThreadId}:${focusRevision}`;
    if (latestAnchorRef.current || latestCaptureRef.current !== 'idle' || requested) return;
    if (!active || active === document.body || root.current?.contains(active)) return;
    heading.current?.focus({ preventScroll: true });
    // Mount only: later opens remount the panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const signature = `${scope}:${focusedThreadId ?? ''}:${focusRevision}`;
    if (!focusedThreadId || signature === focusedRef.current) return;
    const thread = threads.find((thread) => thread.thread_id === focusedThreadId);
    if (!thread) return;
    setTab('comments');
    setFilter((current) =>
      threadDeleted(thread)
        ? 'all'
        : current === 'all' || current === thread.status
          ? current
          : thread.status,
    );
    const frame = requestAnimationFrame(() => {
      focusedRef.current = signature;
      const article = document.getElementById(`artifact-thread-${focusedThreadId}`);
      article?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
      // Keyboard focus follows the thread, except out of a document the person is editing.
      const active = document.activeElement as HTMLElement | null;
      if (active?.isContentEditable && !root.current?.contains(active)) return;
      article?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [scope, focusedThreadId, focusRevision, threads, focusedRef, setTab, setFilter]);
  // Announce comments that arrive by polling. The first read of a scope announces nothing.
  const seen = useRef<{ key: string; ids: Set<string> } | null>(null);
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => {
    const source = comments.data;
    if (!source) return;
    const key = `${scope}:${readOnly}`;
    const ids = (list: readonly ArtifactCommentThread[]) =>
      list.flatMap((thread) => thread.comments.map((comment) => comment.comment_id));
    if (seen.current?.key !== key) {
      seen.current = { key, ids: new Set(ids(source)) };
      return;
    }
    const arrived = arrivedComments(seen.current.ids, source, viewer?.userId);
    for (const id of ids(source)) seen.current.ids.add(id);
    if (!arrived.length) return;
    const author = arrived[0]!.author;
    setAnnouncement(
      arrived.length === 1
        ? t('newCommentFrom', { name: author.kind === 'user' ? author.name : author.agent_name })
        : t('newComments', { count: arrived.length }),
    );
  }, [comments.data, scope, readOnly, t, viewer?.userId]);
  const focusThread = (threadId: string) => {
    const thread = threads.find((thread) => thread.thread_id === threadId);
    setTab('comments');
    if (thread)
      setFilter((current) =>
        threadDeleted(thread)
          ? 'all'
          : current === 'all' || current === thread.status
            ? current
            : thread.status,
      );
    onFocusThread(threadId);
  };
  const perform = async <T,>(
    key: string,
    action: () => Promise<T>,
    onSuccess?: (result: T) => void,
    error?: string,
  ) => {
    if (activeRef.current.has(key)) return;
    activeRef.current.add(key);
    setPending((current) => ({ ...current, [key]: true }));
    setErrors((current) => ({ ...current, [key]: '' }));
    try {
      const result = await action();
      onSuccess?.(result);
    } catch (cause) {
      const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : null;
      const message =
        code === 'artifact_comment_screenshot_limit'
          ? t('sendScreenshotLimit')
          : (error ?? t('commentFailed'));
      setErrors((current) => ({ ...current, [key]: message }));
      if (
        !key.startsWith('new') &&
        !key.startsWith('reply') &&
        !key.startsWith('edit') &&
        !key.startsWith('delete')
      )
        errorToast(message);
    } finally {
      activeRef.current.delete(key);
      setPending((current) => ({ ...current, [key]: false }));
    }
  };
  const composerOpen = canComment && (composing || !!pendingAnchor || selectionCapture !== 'idle');
  const composerAutoFocus =
    !pendingAnchor || pendingAnchor !== pageOpenedAnchor || pendingAnchor === focusedPageAnchor;
  const startComment = () => {
    setTab('comments');
    setComposing(true);
    setComposerFocus((value) => value + 1);
    setFocusedPageAnchor(pendingAnchor ?? null);
  };
  const closeComposer = (discardText: boolean) => {
    if (pendingAnchor || selectionCapture !== 'idle') onClearAnchor();
    if (discardText) setDraft('new', '');
    setComposing(false);
    requestAnimationFrame(() => newButton.current?.focus({ preventScroll: true }));
  };
  const create = () => {
    if (!canComment || !readableVersion || selectionCapture !== 'idle') return;
    const selected = pendingAnchor;
    const anchor = selected ?? { type: 'none' as const, version: readableVersion };
    const text = draft('new');
    const drawing = pendingDrawing?.anchor === selected ? pendingDrawing : null;
    void perform(
      'new',
      () =>
        comments.create({
          body: text,
          anchor,
          ...(drawing
            ? { marks: drawing.marks, screenshot_base64: drawing.screenshot_base64 }
            : {}),
        }),
      (thread) => {
        setDraft('new', '');
        setComposing(false);
        setFilter('open');
        onFocusThread(thread.thread_id);
        if (selected && latestAnchorRef.current === selected && latestCaptureRef.current === 'idle')
          onClearAnchor(selected);
      },
    );
  };
  const setStatus = (thread: ArtifactCommentThread, status: 'open' | 'resolved') =>
    perform(
      `status:${thread.thread_id}`,
      () => comments.setStatus(thread.thread_id, status),
      () => {
        if (status !== 'resolved') return;
        successToast(t('threadResolved'), {
          duration: 5000, // audit:allow toast lifetime for Undo (undoToast's 5 s), not motion
          actions: [{ label: t('undo'), onClick: () => void setStatus(thread, 'open') }],
        });
        // The card leaves the Open list with its focused control: keep focus in the panel.
        requestAnimationFrame(() => {
          if (!document.activeElement || document.activeElement === document.body)
            heading.current?.focus({ preventScroll: true });
        });
      },
      t('statusFailed'),
    );
  const retainedSend = sendRequest?.scope === scope ? sendRequest : null;
  const retryingSend = !!retainedSend && !!errors.send;
  const defaultAgent = context?.send_target?.agent_name ?? sendAgents[0]?.agent_name;
  const chosenAgent =
    sendAgent && sendAgents.some((agent) => agent.agent_name === sendAgent)
      ? sendAgent
      : defaultAgent;
  const agentLabel = (name: string | undefined) =>
    sendAgents.find((agent) => agent.agent_name === name)?.name ?? name ?? '';
  const sendIds =
    retainedSend?.threadIds ??
    (!readOnly && context?.can_comment && context.send_target ? context.send_thread_ids : []);
  const sendTotal = retainedSend?.total ?? context?.send_thread_count;
  const sendable =
    canComment &&
    !!context?.send_target &&
    !agentsUnavailable &&
    sendAgents.length > 0 &&
    (context?.send_thread_count ?? 0) > 0 &&
    sendIds.length > 0 &&
    !!chosenAgent;
  const showSend = tab === 'comments' && !readOnly && (!!retainedSend || sendable);
  const sentToast = (agent: string, sessionId: string) =>
    successToast(t('sentToAgent', { agent: agentLabel(agent) }), {
      actions: [
        {
          label: t('openSession'),
          onClick: () => router.push(`/projects/${projectId}/sessions/${sessionId}`),
        },
      ],
    });
  const send = () => {
    if (!canComment || !context?.send_target) return;
    let batch = sendBatchRef.current;
    if (!batch || batch.scope !== scope) {
      if (!sendIds.length || !chosenAgent) return;
      batch = {
        scope,
        id: crypto.randomUUID(),
        threadIds: [...sendIds],
        total: context.send_thread_count,
        agent: chosenAgent,
      };
      sendBatchRef.current = batch;
      setSendRequest(batch);
    }
    const request = batch;
    void perform(
      'send',
      () =>
        comments
          .send({ thread_ids: [...request.threadIds], batch_id: request.id, agent: request.agent })
          .catch((cause: unknown) => {
            // The server answered, so this batch is final: its job replays the same failure for
            // the same batch id. Only a request with no answer keeps the batch for Retry send.
            if (serverAnswered(cause) && sendBatchRef.current === request) {
              sendBatchRef.current = null;
              setSendRequest((current) => (current === request ? null : current));
            }
            throw cause;
          }),
      (result) => {
        if (sendBatchRef.current === request) {
          sendBatchRef.current = null;
          setSendRequest((current) => (current === request ? null : current));
        }
        sentToast(request.agent, result.session_id);
      },
      t('sendFailed'),
    );
  };
  const discardSend = () => {
    if (activeRef.current.has('send')) return;
    sendBatchRef.current = null;
    setSendRequest(null);
    setErrors((current) => ({ ...current, send: '' }));
  };
  const retryDelivery = (threadId: string, agent: string) => {
    if (!canComment || !context?.send_target) return;
    const held = threadBatchRef.current.get(threadId);
    const batch = held?.agent === agent ? held : { id: crypto.randomUUID(), agent };
    threadBatchRef.current.set(threadId, batch);
    void perform(
      `deliver:${threadId}`,
      () =>
        comments
          .send({ thread_ids: [threadId], batch_id: batch.id, agent })
          .catch((cause: unknown) => {
            // The server answered: a retry with this batch id replays the same failure.
            if (serverAnswered(cause) && threadBatchRef.current.get(threadId) === batch)
              threadBatchRef.current.delete(threadId);
            throw cause;
          }),
      (result) => {
        threadBatchRef.current.delete(threadId);
        sentToast(agent, result.session_id);
      },
      t('sendFailed'),
    );
  };
  /** A failed delivery's retry goes to the agent the delivery went to, else the Send target. */
  const retryProps = (thread: ArtifactCommentThread) => {
    const agent = deliveryAgent(thread) ?? chosenAgent;
    return {
      retryAgentLabel: agentLabel(agent),
      onRetryDelivery:
        canComment && context?.send_target && agent
          ? () => retryDelivery(thread.thread_id, agent)
          : undefined,
    };
  };
  const renderThread = (thread: (typeof threads)[number]) => (
    <ArtifactCommentThreadView
      key={thread.thread_id}
      projectId={projectId}
      thread={thread}
      context={context}
      mentions={mentions}
      focused={focusedThreadId === thread.thread_id}
      readOnly={readOnly}
      pinNumber={pinNumbers?.get(thread.thread_id)}
      agentsUnavailable={agentsUnavailable}
      viewer={viewer}
      reply={{
        value: draft('reply', thread.thread_id),
        pending: !!pending[`reply:${thread.thread_id}`],
        error: errors[`reply:${thread.thread_id}`],
      }}
      editing={
        editing?.threadId === thread.thread_id
          ? {
              commentId: editing.commentId,
              value: draft('edit', editing.commentId),
              pending: !!pending[`edit:${editing.commentId}`],
              error: errors[`edit:${editing.commentId}`],
            }
          : undefined
      }
      statusPending={!!pending[`status:${thread.thread_id}`]}
      deliveryPending={!!pending[`deliver:${thread.thread_id}`]}
      onFocus={() => {
        focusThread(thread.thread_id);
        // A covering panel hides the artifact: close it so the passage shows.
        if (panel.mode === 'cover') panel.close?.();
      }}
      onReplyChange={(value) => setDraft('reply', value, thread.thread_id)}
      onReply={() => {
        const body = draft('reply', thread.thread_id);
        void perform(
          `reply:${thread.thread_id}`,
          () => comments.reply(thread.thread_id, { body }),
          () => setDraft('reply', '', thread.thread_id),
        );
      }}
      onStatus={() => void setStatus(thread, thread.status === 'open' ? 'resolved' : 'open')}
      onEdit={(comment) => {
        setEditing({ threadId: thread.thread_id, commentId: comment.comment_id });
        setDraft('edit', comment.body, comment.comment_id);
      }}
      onEditChange={(value) => {
        if (editing) setDraft('edit', value, editing.commentId);
      }}
      onSaveEdit={(comment) => {
        const body = draft('edit', comment.comment_id);
        void perform(
          `edit:${comment.comment_id}`,
          () => comments.edit(thread.thread_id, comment.comment_id, { body }),
          () =>
            setEditing((current) => (current?.commentId === comment.comment_id ? null : current)),
        );
      }}
      onCancelEdit={() => setEditing(null)}
      onDelete={(comment) => setDeleting({ threadId: thread.thread_id, comment })}
      {...retryProps(thread)}
    />
  );
  const quote =
    pendingAnchor && 'quote' in pendingAnchor
      ? pendingAnchor.quote
      : pendingAnchor && 'snippet' in pendingAnchor
        ? pendingAnchor.snippet
        : '';
  return (
    <div
      ref={root}
      className="flex h-full min-h-0 flex-col"
      data-artifact-discussion
      data-selection-capture={selectionCapture}
    >
      <div aria-live="polite" className="sr-only">
        {announcement}
      </div>
      <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col gap-0">
        <div data-artifact-discussion-header className="shrink-0">
          <div className="border-border flex h-11 items-center gap-2 border-b px-4">
            <h2 ref={heading} tabIndex={-1} className="sr-only outline-none">
              {t('comments')}
            </h2>
            {/* The row draws the rule; the list keeps only the active underline on it. */}
            <TabsListCompact
              type="underline"
              aria-label={t('panelTitle')}
              className="h-full gap-5 border-b-0"
            >
              <TabsTriggerCompact value="comments" className="w-fit flex-none gap-1.5 px-0">
                {t('comments')}
                {counts.open > 0 ? <CountBadge count={counts.open} /> : null}
              </TabsTriggerCompact>
              <TabsTriggerCompact value="activity" className="w-fit flex-none px-0">
                {t('activity')}
              </TabsTriggerCompact>
            </TabsListCompact>
            <div className="ml-auto flex shrink-0 items-center gap-1">
              {canComment ? (
                <Hint label={t('newComment')} side="bottom" sideOffset={4}>
                  <Button
                    ref={newButton}
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t('newComment')}
                    onClick={startComment}
                  >
                    <PlusIcon className="size-4" />
                  </Button>
                </Hint>
              ) : null}
              {panel.close ? (
                <Hint label={panel.closeLabel} side="bottom" sideOffset={4}>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label={panel.closeLabel}
                    onClick={panel.close}
                  >
                    <XIcon className="size-4" />
                  </Button>
                </Hint>
              ) : null}
            </div>
          </div>
          {tab === 'comments' ? (
            <div className="px-4 pt-3 pb-2">
              <Tabs value={filter} onValueChange={(value) => setFilter(value as CommentFilter)}>
                <TabsListCompact aria-label={t('filterLabel')} className="w-full">
                  <TabsTriggerCompact value="open" className="flex-1 gap-1.5">
                    {t('open')}
                    {counts.open > 0 ? <CountBadge count={counts.open} /> : null}
                  </TabsTriggerCompact>
                  <TabsTriggerCompact value="resolved" className="flex-1 gap-1.5">
                    {t('resolved')}
                    {counts.resolved > 0 ? <CountBadge count={counts.resolved} /> : null}
                  </TabsTriggerCompact>
                  <TabsTriggerCompact value="all" className="flex-1">
                    {t('all')}
                  </TabsTriggerCompact>
                </TabsListCompact>
              </Tabs>
            </div>
          ) : null}
        </div>
        <TabsContent value="comments" className="m-0 min-h-0 flex-1 overflow-y-auto">
          {readOnly || contextError || (!context && !contextLoading) ? (
            <div className="space-y-3 px-4 pb-3">
              {readOnly ? (
                <p className="text-muted-foreground text-xs">{t('historicalReadOnly')}</p>
              ) : null}
              {contextError || (!context && !contextLoading) ? (
                <ErrorState
                  size="sm"
                  title={t('contextLoadError')}
                  action={
                    <Button size="xs" variant="outline" onClick={onRetryContext}>
                      {t('retry')}
                    </Button>
                  }
                />
              ) : null}
            </div>
          ) : null}
          {composerOpen ? (
            <section
              aria-label={t('newComment')}
              className="border-border space-y-2.5 border-b px-4 pt-1 pb-3"
            >
              {selectionCapture !== 'idle' ? (
                <div className="flex items-start gap-2">
                  <p
                    role={selectionCapture === 'pending' ? 'status' : 'alert'}
                    className="text-muted-foreground min-w-0 flex-1 text-xs"
                  >
                    {t(
                      selectionCapture === 'pending'
                        ? 'preparingSelection'
                        : 'selectionCaptureFailed',
                    )}
                  </p>
                  <Button type="button" variant="ghost" size="xs" onClick={() => onClearAnchor()}>
                    {t('closeSelection')}
                  </Button>
                </div>
              ) : quote ? (
                <div className="flex items-start gap-2">
                  <blockquote
                    className="bg-kortix-yellow/15 text-foreground min-w-0 flex-1 rounded-sm px-1.5 py-0.5 text-xs"
                    aria-label={t('quoteLabel')}
                  >
                    <span className="line-clamp-3 break-words">{quote}</span>
                  </blockquote>
                  <Hint label={t('closeSelection')} side="top" sideOffset={4}>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t('closeSelection')}
                      onClick={() => onClearAnchor()}
                    >
                      <XIcon className="size-3.5" />
                    </Button>
                  </Hint>
                </div>
              ) : null}
              {pendingDrawing && pendingDrawing.anchor === pendingAnchor ? (
                <div className="space-y-2">
                  <ArtifactCommentImage image={pendingDrawing.image} />
                  {pendingDrawing.imageFailed ? (
                    <p role="status" className="text-muted-foreground text-xs">
                      {t('screenshotCaptureFailed')}
                    </p>
                  ) : null}
                </div>
              ) : null}
              <ArtifactCommentComposer
                value={draft('new')}
                onChange={(value) => setDraft('new', value)}
                onSubmit={create}
                onCancel={() => closeComposer(true)}
                onEscape={() => closeComposer(false)}
                mentions={mentions}
                agentsUnavailable={agentsUnavailable}
                label={t('commentLabel')}
                placeholder={t('commentPlaceholder')}
                submitLabel={t('postComment')}
                pending={!!pending.new}
                submitDisabled={selectionCapture !== 'idle'}
                error={errors.new}
                autoFocus={composerAutoFocus}
                focusKey={`${focusRevision}:${composerFocus}:${JSON.stringify(pendingAnchor)}`}
              />
            </section>
          ) : null}
          {comments.isLoading && !threads.length ? (
            <div className="space-y-4 p-4">
              {[0, 1].map((row) => (
                <Skeleton key={row} className="h-20 w-full" />
              ))}
            </div>
          ) : comments.isError && !threads.length ? (
            <ErrorState
              size="sm"
              title={t('commentsLoadError')}
              action={
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    void comments.refetch();
                  }}
                >
                  {t('retry')}
                </Button>
              }
            />
          ) : !grouped.current.length && !grouped.outdated.length && !composerOpen ? (
            <EmptyState
              size="sm"
              media={<EmptyArt icon={ChatCircleIcon} />}
              title={t(
                filter === 'resolved'
                  ? 'noResolved'
                  : filter === 'all'
                    ? 'noAllComments'
                    : 'noComments',
              )}
              description={t(filter === 'resolved' ? 'noResolvedHint' : 'noCommentsHint')}
            />
          ) : null}
          {grouped.current.map(renderThread)}
          {grouped.outdated.length ? (
            <section>
              <div className="border-border space-y-1 border-b px-4 py-3">
                <h3 className="text-sm font-medium">{t('outdated')}</h3>
                <p className="text-muted-foreground text-xs">{t('outdatedHint')}</p>
              </div>
              {grouped.outdated.map(renderThread)}
            </section>
          ) : null}
          {!canComment && contextLoading ? (
            <div className="flex justify-center p-4">
              <Loading />
            </div>
          ) : null}
        </TabsContent>
        <TabsContent value="activity" className="m-0 min-h-0 flex-1 overflow-y-auto">
          <ArtifactActivityTimeline
            projectId={projectId}
            activity={activity}
            threads={threads}
            people={context?.people}
            onFocusThread={focusThread}
            onOpenVersion={onOpenVersion}
          />
        </TabsContent>
      </Tabs>
      {showSend ? (
        <div className="border-border shrink-0 space-y-2 border-t px-4 py-3">
          {sendTotal !== undefined && sendTotal > sendIds.length ? (
            <p className="text-muted-foreground text-xs">
              {t('sendBatchHint', { count: sendIds.length, total: sendTotal })}
            </p>
          ) : null}
          <ButtonGroup className="w-full">
            <Button
              type="button"
              size="sm"
              className="min-w-0 flex-1"
              disabled={!!pending.send || !canComment || !context?.send_target}
              aria-busy={!!pending.send}
              onClick={send}
            >
              {pending.send ? <Loading className="size-3.5 shrink-0" /> : null}
              <span className="truncate">
                {retryingSend
                  ? t('retrySend', { count: sendIds.length })
                  : t('sendThreads', {
                      count: sendIds.length,
                      agent: agentLabel(retainedSend?.agent ?? chosenAgent),
                    })}
              </span>
            </Button>
            {sendAgents.length > 1 && !retainedSend ? (
              <DropdownMenu>
                <Hint label={t('chooseAgent')} side="top" sideOffset={4}>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      size="icon-base"
                      aria-label={t('chooseAgent')}
                      disabled={!!pending.send}
                    >
                      <CaretDownIcon className="size-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                </Hint>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuRadioGroup
                    value={chosenAgent}
                    onValueChange={(value) => setSendAgent(value)}
                  >
                    {sendAgents.map((agent) => (
                      <DropdownMenuRadioItem key={agent.agent_name} value={agent.agent_name}>
                        <span className="truncate">{agent.name}</span>
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </ButtonGroup>
          {retryingSend ? (
            <>
              <p role="alert" className="text-destructive text-xs">
                {errors.send}
              </p>
              <p className="text-muted-foreground text-xs">{t('sendRetryHint')}</p>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="w-full"
                disabled={!!pending.send}
                onClick={discardSend}
              >
                {t('discardSend')}
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open && !pending[`delete:${deleting?.comment.comment_id}`]) setDeleting(null);
        }}
        title={t('deleteTitle')}
        description={
          <>
            {t(
              threads.find((thread) => thread.thread_id === deleting?.threadId)?.comments[0]
                ?.comment_id === deleting?.comment.comment_id
                ? 'deleteRootDescription'
                : 'deleteDescription',
            )}
            {deleting && errors[`delete:${deleting.comment.comment_id}`] ? (
              <p role="alert" className="text-destructive mt-2">
                {errors[`delete:${deleting.comment.comment_id}`]}
              </p>
            ) : null}
          </>
        }
        confirmLabel={t('delete')}
        confirmVariant="destructive"
        isPending={!!pending[`delete:${deleting?.comment.comment_id}`]}
        onConfirm={() => {
          if (!deleting) return;
          const target = deleting;
          void perform(
            `delete:${target.comment.comment_id}`,
            () => comments.remove(target.threadId, target.comment.comment_id),
            () => {
              setDeleting((current) =>
                current?.comment.comment_id === target.comment.comment_id ? null : current,
              );
              setEditing((current) =>
                current?.commentId === target.comment.comment_id ? null : current,
              );
              heading.current?.focus();
            },
            t('deleteFailed'),
          );
        }}
      />
    </div>
  );
}

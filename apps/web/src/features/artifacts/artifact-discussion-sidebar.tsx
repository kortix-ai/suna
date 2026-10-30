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
import { ConfirmDialog } from '@kortix/ui/confirm-dialog';
import { CountBadge } from '@kortix/ui/count-badge';
import { EmptyArt } from '@kortix/ui/empty-art';
import { EmptyState } from '@kortix/ui/empty-state';
import { ErrorState } from '@kortix/ui/error-state';
import Hint from '@kortix/ui/hint';
import Loading from '@kortix/ui/loading';
import { Skeleton } from '@kortix/ui/skeleton';
import { Tabs, TabsContent, TabsListCompact, TabsTriggerCompact } from '@kortix/ui/tabs';
import { errorToast } from '@kortix/ui/toast';
import { ChatCircleIcon, XIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';

import { useTranslations } from '@/i18n/use-translations';
import {
  ArtifactActivityTimeline,
  type ArtifactDiscussionActivity,
} from './artifact-activity-timeline';
import { ArtifactCommentComposer, type CommentMentionOption } from './artifact-comment-composer';
import { ArtifactCommentImage } from './artifact-comment-image';
import { ArtifactCommentThreadView } from './artifact-comment-thread';
import {
  groupCommentThreads,
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
  target: NonNullable<ArtifactCommentContext['send_target']>;
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
  pendingDrawing?: ArtifactDrawingDraft | null;
  selectionCapture?: 'idle' | 'pending' | 'failed';
  onClearAnchor: (expected?: ArtifactCommentAnchor) => void;
  readOnly?: boolean;
  onOpenVersion: (version: string) => void;
  state?: ReturnType<typeof useArtifactDiscussionState>;
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
  const activeRef = useRef(new Set<string>());
  const focusedRef = useRef('');
  const latestAnchorRef = useRef<ArtifactCommentAnchor | null | undefined>(undefined);
  const latestCaptureRef = useRef<'idle' | 'pending' | 'failed'>('idle');
  const [sendRequest, setSendRequest] = useState<SendRequest | null>(null);
  const sendBatchRef = useRef<SendRequest | null>(null);
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
    activeRef,
    focusedRef,
    latestAnchorRef,
    latestCaptureRef,
    sendRequest,
    setSendRequest,
    sendBatchRef,
  };
}

export function ArtifactDiscussionSidebar({
  projectId,
  artifact,
  comments,
  displayThreads,
  context,
  contextLoading = false,
  contextError = false,
  onRetryContext,
  activity,
  focusedThreadId,
  focusRevision = 0,
  onFocusThread,
  pendingAnchor,
  pendingDrawing,
  selectionCapture = 'idle',
  onClearAnchor,
  readOnly = false,
  onOpenVersion,
  state,
}: ArtifactDiscussionSidebarProps) {
  const t = useTranslations('artifacts.discussion');
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
    activeRef,
    focusedRef,
    latestAnchorRef,
    latestCaptureRef,
    sendRequest,
    setSendRequest,
    sendBatchRef,
  } = state ?? localState;
  const heading = useRef<HTMLHeadingElement>(null);
  const scope = `${projectId}:${artifact.artifact_id}`;
  const draftKey = (kind: string, id = '') => `${scope}:${kind}:${id}`;
  const draft = (kind: string, id = '') => drafts[draftKey(kind, id)] ?? '';
  const setDraft = (kind: string, value: string, id = '') =>
    setDrafts((current) => ({ ...current, [draftKey(kind, id)]: value }));
  const threads = displayThreads ?? comments.data ?? EMPTY_THREADS;
  const grouped = groupCommentThreads(threads, filter);
  const openCount = threads.filter(
    (thread) => thread.status === 'open' && !threadDeleted(thread),
  ).length;
  const readableVersion = context?.version.commit_id ?? context?.version.entry_version;
  const canComment = !readOnly && context?.can_comment === true && !!readableVersion;
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
  useEffect(() => {
    latestAnchorRef.current = pendingAnchor;
    latestCaptureRef.current = selectionCapture;
  }, [pendingAnchor, selectionCapture, latestAnchorRef, latestCaptureRef]);
  useEffect(() => {
    if (!pendingAnchor) return;
    setTab('comments');
    setFilter('open');
  }, [pendingAnchor, setTab, setFilter]);
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
      document
        .getElementById(`artifact-thread-${focusedThreadId}`)
        ?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    });
    return () => cancelAnimationFrame(frame);
  }, [scope, focusedThreadId, focusRevision, threads, focusedRef, setTab, setFilter]);
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
        setFilter('open');
        onFocusThread(thread.thread_id);
        if (selected && latestAnchorRef.current === selected && latestCaptureRef.current === 'idle')
          onClearAnchor(selected);
      },
    );
  };
  const retainedSend = sendRequest?.scope === scope ? sendRequest : null;
  const retryingSend = !!retainedSend && !!errors.send;
  const sendTarget = retainedSend?.target ?? context?.send_target;
  const sendIds =
    retainedSend?.threadIds ??
    (!readOnly && context?.can_comment && context.send_target ? context.send_thread_ids : []);
  const sendTotal = retainedSend?.total ?? context?.send_thread_count;
  const send = () => {
    if (!canComment || !context?.send_target) return;
    let batch = sendBatchRef.current;
    if (!batch || batch.scope !== scope) {
      if (!sendIds.length || !sendTarget) return;
      batch = {
        scope,
        id: crypto.randomUUID(),
        threadIds: [...sendIds],
        total: context.send_thread_count,
        agent: sendTarget.agent_name,
        target: { ...sendTarget },
      };
      sendBatchRef.current = batch;
      setSendRequest(batch);
    }
    const request = batch;
    void perform(
      'send',
      () =>
        comments.send({
          thread_ids: [...request.threadIds],
          batch_id: request.id,
          agent: request.agent,
        }),
      () => {
        if (sendBatchRef.current === request) {
          sendBatchRef.current = null;
          setSendRequest((current) => (current === request ? null : current));
        }
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
  const renderThread = (thread: (typeof threads)[number]) => (
    <ArtifactCommentThreadView
      key={thread.thread_id}
      projectId={projectId}
      thread={thread}
      context={context}
      mentions={mentions}
      focused={focusedThreadId === thread.thread_id}
      readOnly={readOnly}
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
      onFocus={() => focusThread(thread.thread_id)}
      onReplyChange={(value) => setDraft('reply', value, thread.thread_id)}
      onReply={() => {
        const body = draft('reply', thread.thread_id);
        void perform(
          `reply:${thread.thread_id}`,
          () => comments.reply(thread.thread_id, { body }),
          () => setDraft('reply', '', thread.thread_id),
        );
      }}
      onStatus={() => {
        void perform(
          `status:${thread.thread_id}`,
          () =>
            comments.setStatus(thread.thread_id, thread.status === 'open' ? 'resolved' : 'open'),
          undefined,
          t('statusFailed'),
        );
      }}
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
    />
  );
  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-artifact-discussion
      data-selection-capture={selectionCapture}
    >
      <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col gap-0">
        <div data-artifact-discussion-header className="border-border shrink-0 border-b px-4 py-2">
          <h2 ref={heading} tabIndex={-1} className="sr-only outline-none">
            {t('comments')}
          </h2>
          <TabsListCompact type="underline" className="w-full justify-start">
            <TabsTriggerCompact value="comments" className="gap-1.5">
              {t('comments')}
              {openCount > 0 ? <CountBadge count={openCount} /> : null}
            </TabsTriggerCompact>
            <TabsTriggerCompact value="activity">{t('activity')}</TabsTriggerCompact>
          </TabsListCompact>
        </div>
        <TabsContent value="comments" className="m-0 min-h-0 flex-1 overflow-y-auto">
          <div className="border-border space-y-3 border-b px-4 py-3">
            <Tabs value={filter} onValueChange={(value) => setFilter(value as CommentFilter)}>
              <TabsListCompact className="w-full">
                <TabsTriggerCompact value="open" className="flex-1">
                  {t('open')}
                </TabsTriggerCompact>
                <TabsTriggerCompact value="resolved" className="flex-1">
                  {t('resolved')}
                </TabsTriggerCompact>
                <TabsTriggerCompact value="all" className="flex-1">
                  {t('all')}
                </TabsTriggerCompact>
              </TabsListCompact>
            </Tabs>
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
          ) : !grouped.current.length && !grouped.outdated.length ? (
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
              <div className="border-border space-y-1 border-b p-4">
                <h3 className="text-sm font-medium">{t('outdated')}</h3>
                <p className="text-muted-foreground text-xs">{t('outdatedHint')}</p>
              </div>
              {grouped.outdated.map(renderThread)}
            </section>
          ) : null}
          {canComment ? (
            <div className="space-y-3 p-4">
              {selectionCapture !== 'idle' ? (
                <div className="space-y-2">
                  <p
                    role={selectionCapture === 'pending' ? 'status' : 'alert'}
                    className="text-muted-foreground text-xs"
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
              ) : pendingAnchor && ('quote' in pendingAnchor || 'snippet' in pendingAnchor) ? (
                <div className="flex items-start gap-2">
                  <blockquote
                    className="border-border text-muted-foreground min-w-0 flex-1 border-l-2 pl-3 text-xs break-words"
                    aria-label={t('quoteLabel')}
                  >
                    {'quote' in pendingAnchor ? pendingAnchor.quote : pendingAnchor.snippet}
                  </blockquote>
                  <Hint label={t('closeSelection')}>
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      aria-label={t('closeSelection')}
                      onClick={() => onClearAnchor()}
                    >
                      <XIcon className="size-3" />
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
                mentions={mentions}
                label={t('commentLabel')}
                placeholder={t('commentPlaceholder')}
                submitLabel={t('postComment')}
                pending={!!pending.new}
                submitDisabled={selectionCapture !== 'idle'}
                error={errors.new}
                autoFocus={!!pendingAnchor}
                focusKey={`${focusRevision}:${JSON.stringify(pendingAnchor)}`}
              />
            </div>
          ) : contextLoading ? (
            <div className="flex justify-center p-4">
              <Loading />
            </div>
          ) : null}
        </TabsContent>
        <TabsContent value="activity" className="m-0 min-h-0 flex-1 overflow-y-auto">
          <ArtifactActivityTimeline
            projectId={projectId}
            activity={activity}
            onFocusThread={focusThread}
            onOpenVersion={onOpenVersion}
          />
        </TabsContent>
      </Tabs>
      {!readOnly && sendIds.length && sendTarget ? (
        <div className="border-border shrink-0 space-y-2 border-t p-4">
          <p className="text-muted-foreground text-xs">
            {sendTarget.kind === 'session' ? (
              <>
                {t('sendExisting')}{' '}
                <Link
                  className="hover:text-foreground underline underline-offset-2"
                  href={`/projects/${projectId}/sessions/${sendTarget.session_id}`}
                >
                  {sendTarget.agent_name}
                </Link>
              </>
            ) : (
              t('sendNew', { agent: sendTarget.agent_name })
            )}
          </p>
          {sendTotal !== undefined && sendTotal > sendIds.length ? (
            <p className="text-muted-foreground text-xs">
              {t('sendBatchHint', { count: sendIds.length, total: sendTotal })}
            </p>
          ) : null}
          <Button
            type="button"
            size="sm"
            className="w-full"
            disabled={!!pending.send || !canComment || !context?.send_target}
            aria-busy={!!pending.send}
            onClick={send}
          >
            {t(retryingSend ? 'retrySend' : 'sendToAgent', { count: sendIds.length })}
          </Button>
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
              <p role="alert" className="mt-2">
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

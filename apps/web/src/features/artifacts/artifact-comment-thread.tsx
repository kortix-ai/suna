'use client';

import {
  parseArtifactCommentMarks,
  type ArtifactComment,
  type ArtifactCommentContext,
  type ArtifactCommentThread,
} from '@kortix/sdk';
import { cn } from '@kortix/ui';
import { Badge } from '@kortix/ui/badge';
import { Button } from '@kortix/ui/button';
import { MentionChip } from '@kortix/ui/composer';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@kortix/ui/dropdown-menu';
import Hint from '@kortix/ui/hint';
import { AgentMark } from '@kortix/ui/internal/components/agent-mark';
import { InfoBanner } from '@kortix/ui/info-banner';
import Loading from '@kortix/ui/loading';
import { UserAvatar } from '@kortix/ui/user-avatar';
import {
  CheckCircleIcon,
  DotsThreeIcon,
  HandIcon,
  PencilSimpleIcon,
  PaperPlaneTiltIcon,
  TrashIcon,
  WarningCircleIcon,
} from '@phosphor-icons/react';
import Link from 'next/link';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

import { useLocale, useTranslations } from '@/i18n/use-translations';
import { ArtifactCommentComposer, type CommentMentionOption } from './artifact-comment-composer';
import { SavedArtifactCommentImage } from './artifact-comment-image';
import {
  collapseComments,
  deliveryAgent,
  isOptimistic,
  resolverName,
  threadDeleted,
  threadQuote,
} from './artifact-discussion-logic';
import { ArtifactThreadPresence } from './artifact-live-presence';
import { AVATAR_SM_EDGE, relativeTime } from './artifact-meta';

interface ComposerState {
  value: string;
  pending: boolean;
  error?: string | null;
}

/** The signed-in person: the author of a comment the server has not confirmed yet. */
export interface ArtifactCommentViewer {
  userId: string;
  name: string;
  email: string;
  avatarUrl?: string | null;
}

function commentBody(
  comment: ArtifactComment,
  options: readonly CommentMentionOption[],
  unknownPerson: string,
): ReactNode {
  const mentions = comment.mentions
    .flatMap((mention) => {
      const option = options.find((option) =>
        mention.kind === 'user'
          ? option.key === `user:${mention.user_id}`
          : mention.kind === 'session'
            ? option.key === `session:${mention.session_id}`
            : option.key === `agent:${mention.agent_name}`,
      );
      const fallback =
        mention.kind === 'user'
          ? {
              key: `user:${mention.user_id}`,
              kind: 'user',
              label: unknownPerson,
              token: `@${mention.user_id}`,
            }
          : mention.kind === 'session'
            ? {
                key: `session:${mention.session_id}`,
                kind: 'session',
                label: mention.agent_name,
                token: mention.token ?? `@${mention.session_id}`,
              }
            : mention.token
              ? {
                  key: `agent:${mention.agent_name}`,
                  kind: 'agent',
                  label: mention.agent_name,
                  token: mention.token,
                }
              : null;
      return [option, fallback].filter((item): item is CommentMentionOption => !!item);
    })
    .sort((a, b) => b.token.length - a.token.length);
  const parts: ReactNode[] = [];
  let text = '';
  const flush = () => {
    if (text) parts.push(text);
    text = '';
  };
  for (let index = 0; index < comment.body.length;) {
    const mention = mentions.find(
      (item) =>
        comment.body.startsWith(item.token, index) &&
        (index === 0 || !/[\w@]/.test(comment.body[index - 1]!)) &&
        !/[\w@.+-]/.test(comment.body[index + item.token.length] ?? ''),
    );
    if (mention) {
      flush();
      parts.push(
        <MentionChip
          key={`${index}:${mention.key}`}
          kind={mention.kind}
          label={mention.label}
          className="inline-block max-w-full break-words whitespace-normal"
        />,
      );
      index += mention.token.length;
    } else {
      text += comment.body[index];
      index++;
    }
  }
  flush();
  return parts;
}

/** A relative time whose Hint gives the absolute date and time. */
function CommentTime({ at, locale }: { at: string; locale: string }) {
  return (
    <Hint
      side="top"
      sideOffset={4}
      label={new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(at),
      )}
    >
      <time
        // Focusable so the full date is reachable by keyboard, as in Activity.
        tabIndex={0}
        className="text-muted-foreground focus-visible:ring-ring shrink-0 rounded-sm text-xs tabular-nums outline-none focus-visible:ring-2"
        dateTime={at}
      >
        {relativeTime(at, locale)}
      </time>
    </Hint>
  );
}

/** Long comments stop at 6 lines until "Show more". The control appears only when the text overflows. */
function ClampedBody({
  text,
  muted,
  children,
}: {
  text: string;
  /** A resolved thread's text recedes, so open threads lead the list. */
  muted?: boolean;
  children: ReactNode;
}) {
  const t = useTranslations('artifacts.discussion');
  const ref = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || expanded) return;
    const measure = () => setOverflows(element.scrollHeight > element.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [expanded, text]);
  return (
    <>
      <p
        ref={ref}
        className={cn(
          'text-sm text-pretty break-words whitespace-pre-wrap',
          muted ? 'text-muted-foreground' : 'text-foreground',
          !expanded && 'line-clamp-6',
        )}
      >
        {children}
      </p>
      {overflows || expanded ? (
        <button
          type="button"
          aria-expanded={expanded}
          // A text-xs line is 16 px tall: the hit area reaches 28 px without moving the layout.
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring relative mt-1 rounded-sm text-xs font-medium outline-none after:absolute after:inset-x-0 after:-inset-y-1.5 after:content-[''] focus-visible:ring-2"
          onClick={() => setExpanded((value) => !value)}
        >
          {t(expanded ? 'showLess' : 'showMore')}
        </button>
      ) : null}
    </>
  );
}

export function ArtifactCommentThreadView({
  projectId,
  thread,
  context,
  mentions,
  focused,
  readOnly,
  reply,
  editing,
  statusPending,
  pinNumber,
  agentsUnavailable,
  deliveryPending,
  viewer,
  onFocus,
  onReplyChange,
  onReply,
  onStatus,
  onEdit,
  onEditChange,
  onSaveEdit,
  onCancelEdit,
  onLeaveEdit,
  onDelete,
  retryAgentLabel,
  onRetryDelivery,
}: {
  projectId: string;
  thread: ArtifactCommentThread;
  context?: ArtifactCommentContext;
  mentions: readonly CommentMentionOption[];
  focused: boolean;
  readOnly: boolean;
  reply: ComposerState;
  editing?: ComposerState & { commentId: string };
  statusPending: boolean;
  /** The pin number of this thread on an HTML page. */
  pinNumber?: number;
  agentsUnavailable?: boolean;
  deliveryPending?: boolean;
  viewer?: ArtifactCommentViewer;
  onFocus: () => void;
  onReplyChange: (value: string) => void;
  onReply: () => void;
  onStatus: () => void;
  onEdit: (comment: ArtifactComment) => void;
  onEditChange: (value: string) => void;
  onSaveEdit: (comment: ArtifactComment) => void;
  /** Cancel: the edit and its draft go away. */
  onCancelEdit: () => void;
  /** Escape: the editor closes and keeps its draft for the next Edit, as every composer does. */
  onLeaveEdit: () => void;
  onDelete: (comment: ArtifactComment) => void;
  /** The name of the agent `onRetryDelivery` sends to: the button says where the thread goes. */
  retryAgentLabel?: string;
  /** Sends this one thread again after a delivery failure. Absent when the viewer cannot send. */
  onRetryDelivery?: () => void;
}) {
  const t = useTranslations('artifacts.discussion');
  const locale = useLocale();
  const deleted = threadDeleted(thread);
  const writable = !readOnly && context?.can_comment === true && !deleted;
  const canResolve = writable && thread.can_resolve === true;
  // A resolved thread takes no reply: Reopen is its one action.
  const canReply = writable && thread.can_reply === true && thread.status === 'open';
  const quote = threadQuote(thread);
  const sentAgent = thread.agent_state === 'sent' ? deliveryAgent(thread) : undefined;
  const located = !!thread.position && !thread.outdated;
  const [allComments, setAllComments] = useState(false);
  const [replyOpen, setReplyOpen] = useState(() => reply.value !== '');
  const replyControl = useRef<HTMLButtonElement>(null);
  const articleRef = useRef<HTMLElement>(null);
  const wasPending = useRef(reply.pending);
  useEffect(() => {
    const finished = wasPending.current && !reply.pending;
    wasPending.current = reply.pending;
    if (finished && !reply.value && !reply.error) {
      setReplyOpen(false);
      requestAnimationFrame(() => articleRef.current?.focus({ preventScroll: true }));
    }
  }, [reply.pending, reply.value, reply.error]);
  const collapseReply = (focusControl: boolean) => {
    setReplyOpen(false);
    if (!focusControl) return;
    requestAnimationFrame(() => replyControl.current?.focus({ preventScroll: true }));
  };
  // The reply line opens on click (or Enter/Space), never on focus: Tab passes over it.
  const expandReply = () => setReplyOpen(true);
  const resolver =
    resolverName(thread, context, { person: t('person'), agent: t('agent') }) ??
    // An unconfirmed resolve has no resolver yet: the viewer resolved it.
    (isOptimistic(thread) && thread.status === 'resolved' ? (viewer?.name ?? null) : null);
  const { head, hidden, tail } = collapseComments(thread.comments, allComments);
  const renderComment = (comment: ArtifactComment) => {
    const unconfirmed = isOptimistic(comment);
    // A new comment carries a placeholder author until the server answers: show the viewer.
    const author =
      unconfirmed && comment.author.kind === 'user' && !comment.author.user_id && viewer
        ? { kind: 'user' as const, user_id: viewer.userId, name: viewer.name }
        : comment.author;
    const person =
      author.kind === 'user'
        ? context?.people.find((person) => person.user_id === author.user_id)
        : undefined;
    const name = author.kind === 'user' ? author.name : author.agent_name;
    const isEditing = editing?.commentId === comment.comment_id;
    const canEdit = writable && !unconfirmed && !comment.deleted_at && comment.can_edit === true;
    const canDelete =
      writable && !unconfirmed && !comment.deleted_at && comment.can_delete === true;
    const isRoot = comment.comment_id === thread.comments[0]?.comment_id;
    const ratio =
      isRoot && thread.anchor.type === 'region' && thread.anchor.offset.height > 0
        ? thread.anchor.offset.width / thread.anchor.offset.height
        : undefined;
    return (
      <li
        key={comment.comment_id}
        className={cn('group/comment flex items-start gap-2.5', unconfirmed && 'opacity-60')}
        data-comment-id={comment.comment_id}
        data-optimistic={unconfirmed || undefined}
        aria-busy={unconfirmed || undefined}
      >
        <span className="flex h-7 shrink-0 items-center">
          {author.kind === 'user' ? (
            <UserAvatar
              name={name}
              email={
                person?.token.includes('@', 1)
                  ? person.token.slice(1)
                  : viewer && author.user_id === viewer.userId
                    ? viewer.email
                    : ''
              }
              avatarUrl={
                person?.avatar_url ??
                (viewer && author.user_id === viewer.userId ? viewer.avatarUrl : null)
              }
              size="sm"
            />
          ) : (
            <AgentMark slug={name} tile={AVATAR_SM_EDGE} />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex h-7 min-w-0 items-center gap-1.5">
            {author.kind === 'session' ? (
              <Link
                className="text-foreground min-w-0 truncate text-sm font-medium hover:underline"
                href={`/projects/${projectId}/sessions/${author.session_id}`}
              >
                {name}
              </Link>
            ) : (
              <span className="text-foreground min-w-0 truncate text-sm font-medium">{name}</span>
            )}
            <CommentTime at={comment.created_at} locale={locale} />
            {comment.edited_at && !comment.deleted_at ? (
              <span className="text-muted-foreground shrink-0 text-xs">{t('edited')}</span>
            ) : null}
            <span className="ml-auto flex shrink-0 items-center">
              {isRoot && canResolve && !unconfirmed && thread.status === 'open' ? (
                <Hint label={t('resolve')} side="bottom" sideOffset={4}>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t('resolve')}
                    className="opacity-0 group-focus-within/thread:opacity-100 group-hover/thread:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
                    disabled={statusPending}
                    aria-busy={statusPending}
                    onClick={onStatus}
                  >
                    {statusPending ? (
                      <Loading className="size-4 shrink-0" />
                    ) : (
                      <CheckCircleIcon className="size-4" />
                    )}
                  </Button>
                </Hint>
              ) : null}
              {canEdit || canDelete ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t('commentActions')}
                      className="opacity-0 group-focus-within/thread:opacity-100 group-hover/thread:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 pointer-coarse:opacity-100"
                    >
                      <DotsThreeIcon className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {canEdit ? (
                      <DropdownMenuItem onSelect={() => onEdit(comment)}>
                        <PencilSimpleIcon />
                        {t('edit')}
                      </DropdownMenuItem>
                    ) : null}
                    {canDelete ? (
                      <DropdownMenuItem variant="destructive" onSelect={() => onDelete(comment)}>
                        <TrashIcon />
                        {t('delete')}
                      </DropdownMenuItem>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </span>
          </div>
          {comment.deleted_at ? (
            <p className="text-muted-foreground text-sm">{t('commentDeleted')}</p>
          ) : isEditing ? (
            <div className="pt-1">
              <ArtifactCommentComposer
                value={editing.value}
                onChange={onEditChange}
                onSubmit={() => onSaveEdit(comment)}
                onCancel={onCancelEdit}
                onEscape={onLeaveEdit}
                mentions={mentions}
                agentsUnavailable={agentsUnavailable}
                label={t('commentLabel')}
                placeholder={t('commentPlaceholder')}
                submitLabel={t('saveEdit')}
                pending={editing.pending}
                error={editing.error}
                compact
                autoFocus
                liveTyping={{ thread_id: thread.thread_id }}
              />
            </div>
          ) : (
            <ClampedBody text={comment.body} muted={thread.status === 'resolved'}>
              {commentBody(comment, mentions, t('person'))}
            </ClampedBody>
          )}
          {!comment.deleted_at && comment.screenshot_key ? (
            <div className="pt-2">
              <SavedArtifactCommentImage
                projectId={projectId}
                artifactId={thread.artifact_id}
                commentId={comment.comment_id}
                aspectRatio={ratio}
              />
            </div>
          ) : !comment.deleted_at && parseArtifactCommentMarks(comment.marks)?.length ? (
            <p className="text-muted-foreground pt-1 text-xs">{t('screenshotMissing')}</p>
          ) : null}
        </div>
      </li>
    );
  };
  return (
    <article
      ref={articleRef}
      id={`artifact-thread-${thread.thread_id}`}
      // ARIA 1.3: a doc highlight's aria-details points here, so the passage reads as "has comment".
      role="comment"
      data-thread-id={thread.thread_id}
      data-focused={focused || undefined}
      // Focused only by code (a highlight or a deep link), never by Tab.
      tabIndex={-1}
      className={cn(
        'group/thread relative mx-2 space-y-2 rounded-md px-2 py-2.5 outline-none',
        // A thread opened from its passage or a link keeps a ring in the highlight colour.
        focused ? 'bg-active ring-kortix-yellow ring-1' : 'hover:bg-hover focus-within:bg-hover',
      )}
    >
      {pinNumber !== undefined || quote ? (
        <div className="flex items-start gap-2">
          {pinNumber !== undefined ? (
            <Badge
              variant="solid"
              size="tabular"
              className="mt-0.5"
              aria-label={t('pagePinLabel', { number: pinNumber })}
            >
              {pinNumber}
            </Badge>
          ) : null}
          {quote ? (
            located ? (
              <Hint label={t('focusThread')} side="top" sideOffset={4}>
                <button
                  type="button"
                  className="border-kortix-yellow text-muted-foreground hover:text-foreground focus-visible:ring-ring min-w-0 border-l-2 pl-2 text-left text-xs outline-none focus-visible:ring-2"
                  onClick={onFocus}
                >
                  {/* The passage is the name a screen reader hears, then what the button does. */}
                  <span className="line-clamp-2 break-words">{quote}</span>
                  <span className="sr-only">{`, ${t('focusThread')}`}</span>
                </button>
              </Hint>
            ) : (
              <blockquote
                className="border-border text-muted-foreground min-w-0 border-l-2 pl-2 text-xs"
                aria-label={t('quoteLabel')}
              >
                <span className="line-clamp-2 break-words">{quote}</span>
              </blockquote>
            )
          ) : null}
        </div>
      ) : null}
      {thread.agent_error ? (
        <Badge variant="destructive" size="sm">
          <WarningCircleIcon />
          {t('notDelivered')}
        </Badge>
      ) : thread.agent_state === 'pending' ? (
        <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <Loading className="size-3.5 shrink-0" />
          {t('agentPending')}
        </p>
      ) : thread.agent_state === 'sent' ? (
        <p className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
          {sentAgent ? (
            <AgentMark slug={sentAgent} />
          ) : (
            <PaperPlaneTiltIcon className="size-3.5 shrink-0" aria-hidden />
          )}
          <span className="truncate">{t('agentSent')}</span>
          {thread.sent_session_id ? (
            <>
              <span aria-hidden>·</span>
              <Link
                className="text-foreground shrink-0 underline-offset-2 hover:underline"
                href={`/projects/${projectId}/sessions/${thread.sent_session_id}`}
              >
                {t('openSession')}
              </Link>
            </>
          ) : null}
        </p>
      ) : thread.agent_state === 'paused' ? (
        <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <HandIcon className="text-kortix-orange size-3.5 shrink-0" aria-hidden />
          {t('waitingForPerson')}
        </p>
      ) : null}
      {deleted ? (
        <p role="status" className="text-muted-foreground text-xs">
          {t('threadDeleted')}
        </p>
      ) : null}
      <ol className="space-y-3">
        {head.map(renderComment)}
        {hidden ? (
          <li className="flex items-center gap-2.5">
            <span aria-hidden className="size-6 shrink-0" />
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground focus-visible:ring-ring relative rounded-sm text-xs font-medium tabular-nums outline-none after:absolute after:inset-x-0 after:-inset-y-1.5 after:content-[''] focus-visible:ring-2"
              onClick={() => setAllComments(true)}
            >
              {t('moreReplies', { count: hidden })}
            </button>
          </li>
        ) : null}
        {tail.map(renderComment)}
      </ol>
      {thread.status === 'resolved' ? (
        // The status closes the thread, aligned with the comment text.
        <div className="text-muted-foreground flex min-w-0 items-center gap-2.5 text-xs">
          <span aria-hidden className="flex size-6 shrink-0 items-center justify-center">
            <CheckCircleIcon weight="fill" className="size-3.5" />
          </span>
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <span className="min-w-0 truncate">
              {resolver ? t('resolvedBy', { name: resolver }) : t('resolved')}
            </span>
            {thread.resolved_at ? (
              <>
                <span aria-hidden>·</span>
                <CommentTime at={thread.resolved_at} locale={locale} />
              </>
            ) : null}
          </span>
          {canResolve ? (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              className="-mr-2 shrink-0"
              disabled={statusPending}
              aria-busy={statusPending}
              onClick={onStatus}
            >
              {statusPending ? <Loading className="size-3.5 shrink-0" /> : null}
              {t('reopen')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {/* Live: agents working here, "is writing…", "is typing…". */}
      <ArtifactThreadPresence threadId={thread.thread_id} />
      {thread.agent_error ? (
        <InfoBanner
          tone="destructive"
          icon={WarningCircleIcon}
          title={t('deliveryFailed')}
          action={
            onRetryDelivery && !deleted ? (
              <Button
                type="button"
                size="xs"
                variant="outline"
                className="max-w-48 min-w-0"
                disabled={deliveryPending}
                aria-busy={deliveryPending}
                onClick={onRetryDelivery}
              >
                {deliveryPending ? <Loading className="size-3.5 shrink-0" /> : null}
                <span className="truncate">
                  {retryAgentLabel ? t('sendAgainTo', { agent: retryAgentLabel }) : t('retry')}
                </span>
              </Button>
            ) : undefined
          }
        >
          <span className="break-words">{thread.agent_error}</span>
        </InfoBanner>
      ) : null}
      {canReply ? (
        // A draft always shows in its box, so it never reads as a posted reply.
        replyOpen || reply.value ? (
          <div
            // Aligned with the comment text: the avatar column stays empty.
            className="flex gap-2.5"
            onBlur={(event) => {
              if (
                !event.currentTarget.contains(event.relatedTarget as Node | null) &&
                !reply.value.trim() &&
                !reply.pending
              )
                setReplyOpen(false);
            }}
          >
            <span aria-hidden className="w-6 shrink-0" />
            <div className="min-w-0 flex-1">
              <ArtifactCommentComposer
                value={reply.value}
                onChange={onReplyChange}
                onSubmit={onReply}
                onCancel={() => {
                  onReplyChange('');
                  collapseReply(true);
                }}
                // Escape leaves the box and keeps the draft: a draft stays in its open box, so
                // focus goes to the thread; an empty box closes back to the reply line.
                onEscape={() => {
                  if (!reply.value.trim()) return collapseReply(true);
                  requestAnimationFrame(() => articleRef.current?.focus({ preventScroll: true }));
                }}
                mentions={mentions}
                agentsUnavailable={agentsUnavailable}
                label={t('replyLabel')}
                placeholder={t('replyPlaceholder')}
                submitLabel={t('postReply')}
                pending={reply.pending}
                error={reply.error}
                compact
                autoFocus
                liveTyping={{ thread_id: thread.thread_id }}
              />
            </div>
          </div>
        ) : (
          <div className="flex gap-2.5">
            <span aria-hidden className="w-6 shrink-0" />
            <button
              ref={replyControl}
              type="button"
              aria-label={t('replyLabel')}
              // A quiet line, not a field: the composer opens on click.
              className="focus-visible:ring-ring text-muted-foreground hover:text-foreground relative flex min-w-0 items-center rounded-sm text-left text-sm outline-none after:absolute after:inset-x-0 after:-inset-y-1 after:content-[''] focus-visible:ring-2"
              onClick={expandReply}
            >
              <span className="truncate">{t('replyPlaceholder')}</span>
            </button>
          </div>
        )
      ) : null}
    </article>
  );
}

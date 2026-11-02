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
import { EntityAvatar } from '@kortix/ui/entity-avatar';
import Hint from '@kortix/ui/hint';
import { InfoBanner } from '@kortix/ui/info-banner';
import { inputFocusClasses, inputSurfaceClasses } from '@kortix/ui/input';
import Loading from '@kortix/ui/loading';
import { UserAvatar } from '@kortix/ui/user-avatar';
import {
  CheckCircleIcon,
  DotsThreeIcon,
  HandIcon,
  PencilSimpleIcon,
  RobotIcon,
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
  isOptimistic,
  resolverName,
  threadDeleted,
  threadQuote,
} from './artifact-discussion-logic';
import { relativeTime } from './artifact-meta';

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
      <time className="text-muted-foreground shrink-0 text-xs tabular-nums" dateTime={at}>
        {relativeTime(at, locale)}
      </time>
    </Hint>
  );
}

/** Long comments stop at 6 lines until "Show more". The control appears only when the text overflows. */
function ClampedBody({ text, children }: { text: string; children: ReactNode }) {
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
          'text-foreground text-sm text-pretty break-words whitespace-pre-wrap',
          !expanded && 'line-clamp-6',
        )}
      >
        {children}
      </p>
      {overflows || expanded ? (
        <button
          type="button"
          aria-expanded={expanded}
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring mt-1 rounded-sm text-xs font-medium outline-none focus-visible:ring-2"
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
  onCancelEdit: () => void;
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
  const canReply = writable && thread.can_reply === true;
  const quote = threadQuote(thread);
  const located = !!thread.position && !thread.outdated;
  const [allComments, setAllComments] = useState(false);
  const [replyOpen, setReplyOpen] = useState(() => reply.value !== '');
  const replyControl = useRef<HTMLButtonElement>(null);
  const articleRef = useRef<HTMLElement>(null);
  // Focus that returns to the collapsed control after Escape must not expand it again.
  const restoringFocus = useRef(false);
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
    requestAnimationFrame(() => {
      restoringFocus.current = true;
      replyControl.current?.focus({ preventScroll: true });
      restoringFocus.current = false;
    });
  };
  const expandReply = () => {
    if (!restoringFocus.current) setReplyOpen(true);
  };
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
            <EntityAvatar icon={RobotIcon} label={name} size="sm" />
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
                <Hint label={t('resolve')} side="top" sideOffset={4}>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t('resolve')}
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
                      className="opacity-0 group-focus-within/comment:opacity-100 group-hover/comment:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 pointer-coarse:opacity-100"
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
                onEscape={onCancelEdit}
                mentions={mentions}
                agentsUnavailable={agentsUnavailable}
                label={t('commentLabel')}
                placeholder={t('commentPlaceholder')}
                submitLabel={t('saveEdit')}
                pending={editing.pending}
                error={editing.error}
                compact
                autoFocus
              />
            </div>
          ) : (
            <ClampedBody text={comment.body}>
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
        'border-border relative space-y-2.5 border-b px-4 py-3 outline-none',
        focused ? 'bg-active' : 'hover:bg-hover focus-within:bg-hover',
      )}
    >
      {focused ? (
        // 2px: a whole-pixel bar. w-0.5 is 1.84px (--spacing is 0.23rem) and rounds unevenly.
        <span aria-hidden className="bg-kortix-yellow absolute inset-y-0 left-0 w-[2px]" />
      ) : null}
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
                  className="bg-kortix-yellow/15 text-foreground hover:ring-kortix-yellow focus-visible:ring-ring min-w-0 rounded-sm px-1.5 py-0.5 text-left text-xs outline-none hover:ring-1 focus-visible:ring-2"
                  aria-label={t('focusThread')}
                  onClick={onFocus}
                >
                  <span className="line-clamp-2 break-words">{quote}</span>
                </button>
              </Hint>
            ) : (
              <blockquote
                className="bg-muted text-muted-foreground min-w-0 rounded-sm px-1.5 py-0.5 text-xs"
                aria-label={t('quoteLabel')}
              >
                <span className="line-clamp-2 break-words">{quote}</span>
              </blockquote>
            )
          ) : null}
        </div>
      ) : null}
      {thread.status === 'resolved' ? (
        <div className="text-muted-foreground flex min-h-7 items-center gap-1.5 text-xs">
          <div className="flex min-w-0 flex-1 items-start gap-1.5">
            <CheckCircleIcon
              weight="fill"
              className="text-kortix-green mt-0.5 size-3.5 shrink-0"
              aria-hidden
            />
            <p className="min-w-0 break-words">
              {resolver ? t('resolvedBy', { name: resolver }) : t('resolved')}
              {thread.resolved_at ? (
                <>
                  {' · '}
                  <CommentTime at={thread.resolved_at} locale={locale} />
                </>
              ) : null}
            </p>
          </div>
          {canResolve ? (
            <Button
              type="button"
              size="xs"
              variant="ghost"
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
          <RobotIcon className="size-3.5 shrink-0" aria-hidden />
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
              className="text-muted-foreground hover:text-foreground focus-visible:ring-ring rounded-sm text-xs font-medium outline-none focus-visible:ring-2"
              onClick={() => setAllComments(true)}
            >
              {t('moreReplies', { count: hidden })}
            </button>
          </li>
        ) : null}
        {tail.map(renderComment)}
      </ol>
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
        replyOpen ? (
          <div
            onBlur={(event) => {
              if (
                !event.currentTarget.contains(event.relatedTarget as Node | null) &&
                !reply.value.trim() &&
                !reply.pending
              )
                setReplyOpen(false);
            }}
          >
            <ArtifactCommentComposer
              value={reply.value}
              onChange={onReplyChange}
              onSubmit={onReply}
              onCancel={() => {
                onReplyChange('');
                collapseReply(true);
              }}
              onEscape={() => collapseReply(true)}
              mentions={mentions}
              agentsUnavailable={agentsUnavailable}
              label={t('replyLabel')}
              placeholder={t('replyPlaceholder')}
              submitLabel={t('postReply')}
              pending={reply.pending}
              error={reply.error}
              compact
              autoFocus
            />
          </div>
        ) : (
          <button
            ref={replyControl}
            type="button"
            aria-label={t('replyLabel')}
            className={cn(
              inputSurfaceClasses,
              inputFocusClasses,
              'flex h-8 w-full min-w-0 items-center px-3 text-left text-sm',
              reply.value ? 'text-foreground' : 'text-muted-foreground',
            )}
            onClick={expandReply}
            onFocus={expandReply}
          >
            <span className="truncate">{reply.value || t('replyPlaceholder')}</span>
          </button>
        )
      ) : null}
    </article>
  );
}

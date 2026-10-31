'use client';

import {
  parseArtifactCommentMarks,
  type ArtifactComment,
  type ArtifactCommentContext,
  type ArtifactCommentThread,
} from '@kortix/sdk';
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
import { UserAvatar } from '@kortix/ui/user-avatar';
import {
  CheckIcon,
  DotsThreeIcon,
  PencilSimpleIcon,
  RobotIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { useLocale, useTranslations } from '@/i18n/use-translations';
import { ArtifactCommentComposer, type CommentMentionOption } from './artifact-comment-composer';
import { SavedArtifactCommentImage } from './artifact-comment-image';
import { threadDeleted } from './artifact-discussion-logic';
import { relativeTime } from './artifact-meta';

interface ComposerState {
  value: string;
  pending: boolean;
  error?: string | null;
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
  onFocus,
  onReplyChange,
  onReply,
  onStatus,
  onEdit,
  onEditChange,
  onSaveEdit,
  onCancelEdit,
  onDelete,
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
  onFocus: () => void;
  onReplyChange: (value: string) => void;
  onReply: () => void;
  onStatus: () => void;
  onEdit: (comment: ArtifactComment) => void;
  onEditChange: (value: string) => void;
  onSaveEdit: (comment: ArtifactComment) => void;
  onCancelEdit: () => void;
  onDelete: (comment: ArtifactComment) => void;
}) {
  const t = useTranslations('artifacts.discussion');
  const locale = useLocale();
  const deleted = threadDeleted(thread);
  const writable = !readOnly && context?.can_comment === true && !deleted;
  const quote =
    thread.anchor.type === 'text'
      ? thread.anchor.quote
      : 'snippet' in thread.anchor
        ? thread.anchor.snippet
        : '';
  return (
    <article
      id={`artifact-thread-${thread.thread_id}`}
      data-thread-id={thread.thread_id}
      data-focused={focused || undefined}
      className={`border-border space-y-3 border-b p-4 ${focused ? 'bg-active' : ''}`}
    >
      {quote ? (
        thread.position && !thread.outdated ? (
          <button
            type="button"
            className="border-border text-muted-foreground hover:text-foreground w-full border-l-2 pl-3 text-left text-xs break-words"
            aria-label={t('focusThread')}
            onClick={onFocus}
          >
            {quote}
          </button>
        ) : (
          <blockquote
            className="border-border text-muted-foreground border-l-2 pl-3 text-xs break-words"
            aria-label={t('quoteLabel')}
          >
            {quote}
          </blockquote>
        )
      ) : null}
      {thread.status === 'resolved' || thread.agent_state === 'paused' ? (
        <div className="flex flex-wrap gap-1.5">
          {thread.status === 'resolved' ? (
            <Badge variant="success" size="xs">
              <CheckIcon />
              {t('resolved')}
            </Badge>
          ) : null}
          {thread.agent_state === 'paused' ? (
            <Badge variant="warning" size="xs">
              {thread.agent_error ? t('deliveryFailed') : t('waitingForPerson')}
            </Badge>
          ) : null}
        </div>
      ) : null}
      {deleted ? (
        <p role="status" className="text-muted-foreground text-xs">
          {t('threadDeleted')}
        </p>
      ) : null}
      <ol className="space-y-4">
        {thread.comments.map((comment) => {
          const author = comment.author;
          const person =
            author.kind === 'user'
              ? context?.people.find((person) => person.user_id === author.user_id)
              : undefined;
          const name = author.kind === 'user' ? author.name : author.agent_name;
          const isEditing = editing?.commentId === comment.comment_id;
          const canEdit = writable && !comment.deleted_at && comment.can_edit === true;
          const canDelete = writable && !comment.deleted_at && comment.can_delete === true;
          return (
            <li
              key={comment.comment_id}
              className="flex items-start gap-2.5"
              data-comment-id={comment.comment_id}
            >
              {author.kind === 'user' ? (
                <UserAvatar
                  name={name}
                  email={person?.token.includes('@', 1) ? person.token.slice(1) : ''}
                  avatarUrl={person?.avatar_url}
                  size="sm"
                />
              ) : (
                <EntityAvatar icon={RobotIcon} label={name} size="sm" />
              )}
              <div className="min-w-0 flex-1 space-y-2">
                <div className="flex items-center gap-2 text-xs">
                  {author.kind === 'session' ? (
                    <Link
                      className="min-w-0 truncate font-medium hover:underline"
                      href={`/projects/${projectId}/sessions/${author.session_id}`}
                    >
                      {name}
                    </Link>
                  ) : (
                    <span className="min-w-0 truncate font-medium">{name}</span>
                  )}
                  <Hint
                    label={new Intl.DateTimeFormat(locale, {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    }).format(new Date(comment.created_at))}
                  >
                    <time className="text-muted-foreground shrink-0" dateTime={comment.created_at}>
                      {relativeTime(comment.created_at, locale)}
                    </time>
                  </Hint>
                  {comment.edited_at && !comment.deleted_at ? (
                    <span className="text-muted-foreground">{t('edited')}</span>
                  ) : null}
                  {canEdit || canDelete ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          className="ml-auto"
                          size="icon-xs"
                          variant="ghost"
                          aria-label={t('commentActions')}
                        >
                          <DotsThreeIcon className="size-3.5" />
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
                          <DropdownMenuItem
                            variant="destructive"
                            onSelect={() => onDelete(comment)}
                          >
                            <TrashIcon />
                            {t('delete')}
                          </DropdownMenuItem>
                        ) : null}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                </div>
                {comment.deleted_at ? (
                  <p className="text-muted-foreground text-sm">{t('commentDeleted')}</p>
                ) : isEditing ? (
                  <ArtifactCommentComposer
                    value={editing.value}
                    onChange={onEditChange}
                    onSubmit={() => onSaveEdit(comment)}
                    onCancel={onCancelEdit}
                    mentions={mentions}
                    label={t('commentLabel')}
                    placeholder={t('commentPlaceholder')}
                    submitLabel={t('saveEdit')}
                    pending={editing.pending}
                    error={editing.error}
                    autoFocus
                  />
                ) : (
                  <p className="text-foreground text-sm break-words whitespace-pre-wrap">
                    {commentBody(comment, mentions, t('person'))}
                  </p>
                )}
                {!comment.deleted_at && comment.screenshot_key ? (
                  <SavedArtifactCommentImage
                    projectId={projectId}
                    artifactId={thread.artifact_id}
                    commentId={comment.comment_id}
                  />
                ) : !comment.deleted_at && parseArtifactCommentMarks(comment.marks)?.length ? (
                  <p className="text-muted-foreground text-xs">{t('screenshotMissing')}</p>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
      {writable && thread.can_resolve === true ? (
        <div className="flex justify-end">
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={statusPending}
            aria-busy={statusPending}
            onClick={onStatus}
          >
            {thread.status === 'open' ? t('resolve') : t('reopen')}
          </Button>
        </div>
      ) : null}
      {writable && thread.can_reply === true ? (
        <ArtifactCommentComposer
          value={reply.value}
          onChange={onReplyChange}
          onSubmit={onReply}
          mentions={mentions}
          label={t('replyLabel')}
          placeholder={t('replyPlaceholder')}
          submitLabel={t('postReply')}
          pending={reply.pending}
          error={reply.error}
        />
      ) : null}
    </article>
  );
}

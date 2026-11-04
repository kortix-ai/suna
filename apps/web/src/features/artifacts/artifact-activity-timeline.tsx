'use client';

import type { ArtifactActivityItem, ArtifactCommentContext, ArtifactCommentThread } from '@kortix/sdk';
import { cn } from '@kortix/ui';
import { Button } from '@kortix/ui/button';
import { EmptyArt } from '@kortix/ui/empty-art';
import { EmptyState } from '@kortix/ui/empty-state';
import { EntityAvatar } from '@kortix/ui/entity-avatar';
import { ErrorState } from '@kortix/ui/error-state';
import Hint from '@kortix/ui/hint';
import Loading from '@kortix/ui/loading';
import { Skeleton } from '@kortix/ui/skeleton';
import { UserAvatar } from '@kortix/ui/user-avatar';
import { ClockCounterClockwiseIcon, RobotIcon } from '@phosphor-icons/react';
import Link from 'next/link';

import { useLocale, useTranslations } from '@/i18n/use-translations';
import {
  activityExcerpt,
  activityThreadId,
  activityVersionId,
  groupActivityDays,
} from './artifact-discussion-logic';
import { relativeTime } from './artifact-meta';

export interface ArtifactDiscussionActivity {
  items: readonly ArtifactActivityItem[];
  isLoading: boolean;
  isError: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  olderVersions: boolean;
  onLoadMore: () => void;
  onRetry: () => void;
}

const NO_THREADS: readonly ArtifactCommentThread[] = [];

export function ArtifactActivityTimeline({
  projectId,
  activity,
  threads = NO_THREADS,
  people,
  onFocusThread,
  onOpenVersion,
}: {
  projectId: string;
  activity: ArtifactDiscussionActivity;
  /** Loaded threads: a thread row names its passage or comment from them. */
  threads?: readonly ArtifactCommentThread[];
  /** Context people: a person row shows their avatar. */
  people?: ArtifactCommentContext['people'];
  onFocusThread: (threadId: string) => void;
  onOpenVersion: (version: string) => void;
}) {
  const t = useTranslations('artifacts.discussion');
  const locale = useLocale();
  if (activity.isLoading && !activity.items.length)
    return (
      <div className="space-y-4 p-4">
        {[0, 1, 2].map((row) => (
          <Skeleton key={row} className="h-10 w-full" />
        ))}
      </div>
    );
  if (activity.isError && !activity.items.length)
    return (
      <ErrorState
        size="sm"
        title={t('activityLoadError')}
        action={
          <Button size="sm" variant="outline" onClick={activity.onRetry}>
            {t('retry')}
          </Button>
        }
      />
    );
  if (!activity.items.length)
    return (
      <EmptyState
        size="sm"
        media={<EmptyArt icon={ClockCounterClockwiseIcon} />}
        title={t('noActivity')}
        description={t('noActivityHint')}
      />
    );
  const absolute = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <div className="space-y-5 p-4">
      {groupActivityDays(activity.items).map((group) => (
        <section key={group.key} className="space-y-1">
          <h3 className="text-muted-foreground text-xs font-medium">
            {new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(group.day)}
          </h3>
          <ol className="-mx-2">
            {group.items.map((item) => {
              const threadId = activityThreadId(item);
              const version = activityVersionId(item);
              const actor = item.actor;
              const actorName = actor.kind === 'system' ? t('systemActor') : actor.name;
              const person =
                actor.kind === 'user'
                  ? people?.find((candidate) => candidate.user_id === actor.id)
                  : undefined;
              const verb = t(`events.${item.type}`);
              const label = `${actorName} ${verb}`;
              const object =
                item.type === 'published'
                  ? item.data.title
                  : item.type === 'renamed'
                    ? item.data.to
                    : item.type === 'sent_to_agent'
                      ? item.data.agent_name
                      : null;
              const detail =
                activityExcerpt(item, threads) ??
                (typeof object === 'string' && object ? object : null);
              const target = version || threadId;
              return (
                <li
                  key={item.id}
                  className={cn(
                    'relative flex items-start gap-2.5 rounded-md px-2 py-2',
                    target && 'hover:bg-hover',
                  )}
                  data-activity-id={item.id}
                >
                  {actor.kind === 'user' ? (
                    <UserAvatar
                      email={person?.token.includes('@', 1) ? person.token.slice(1) : ''}
                      name={actorName}
                      avatarUrl={person?.avatar_url}
                      size="sm"
                    />
                  ) : (
                    <EntityAvatar
                      label={actorName}
                      icon={actor.kind === 'session' ? RobotIcon : ClockCounterClockwiseIcon}
                      size="sm"
                    />
                  )}
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <p className="text-sm break-words">
                      {actor.kind === 'session' ? (
                        <Link
                          href={`/projects/${projectId}/sessions/${actor.id}`}
                          className="relative z-10 font-medium hover:underline"
                        >
                          {actorName}
                        </Link>
                      ) : (
                        <span className="font-medium">{actorName}</span>
                      )}{' '}
                      {target ? (
                        // The whole row is the target: the button's ::after covers the row.
                        <button
                          type="button"
                          className="text-foreground focus-visible:after:ring-ring text-left break-words outline-none after:absolute after:inset-0 after:rounded-md focus-visible:after:ring-2"
                          aria-label={label}
                          onClick={() =>
                            version ? onOpenVersion(version) : onFocusThread(threadId!)
                          }
                        >
                          {verb}
                        </button>
                      ) : (
                        verb
                      )}{' '}
                      <Hint label={absolute.format(new Date(item.at))} side="top" sideOffset={4}>
                        <time
                          // Focusable so the absolute time is reachable by keyboard.
                          tabIndex={0}
                          className="text-muted-foreground focus-visible:ring-ring relative z-10 rounded-sm text-xs whitespace-nowrap tabular-nums outline-none focus-visible:ring-2"
                          dateTime={item.at}
                        >
                          {relativeTime(item.at, locale)}
                        </time>
                      </Hint>
                    </p>
                    {detail ? (
                      <p className="text-muted-foreground line-clamp-2 text-xs break-words">
                        {detail}
                      </p>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
      {activity.isError ? (
        <ErrorState
          size="sm"
          title={t('activityLoadError')}
          action={
            <Button size="sm" variant="outline" onClick={activity.onRetry}>
              {t('retry')}
            </Button>
          }
        />
      ) : null}
      {activity.hasNextPage ? (
        <Button
          size="sm"
          variant="outline"
          className="w-full"
          disabled={activity.isFetchingNextPage}
          aria-busy={activity.isFetchingNextPage}
          onClick={activity.onLoadMore}
        >
          {activity.isFetchingNextPage ? <Loading className="size-3.5 shrink-0" /> : null}
          {t('loadMore')}
        </Button>
      ) : null}
      {activity.olderVersions ? (
        <p className="text-muted-foreground text-xs">{t('olderSaves')}</p>
      ) : null}
    </div>
  );
}

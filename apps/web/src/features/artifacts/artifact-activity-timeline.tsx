'use client';

import type { ArtifactActivityItem } from '@kortix/sdk';
import { Button } from '@kortix/ui/button';
import { EmptyArt } from '@kortix/ui/empty-art';
import { EmptyState } from '@kortix/ui/empty-state';
import { EntityAvatar } from '@kortix/ui/entity-avatar';
import { ErrorState } from '@kortix/ui/error-state';
import { Skeleton } from '@kortix/ui/skeleton';
import { UserAvatar } from '@kortix/ui/user-avatar';
import { ClockCounterClockwiseIcon, RobotIcon } from '@phosphor-icons/react';
import Link from 'next/link';

import { useLocale, useTranslations } from '@/i18n/use-translations';
import {
  activityThreadId,
  activityVersionId,
  groupActivityDays,
} from './artifact-discussion-logic';

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

export function ArtifactActivityTimeline({
  projectId,
  activity,
  onFocusThread,
  onOpenVersion,
}: {
  projectId: string;
  activity: ArtifactDiscussionActivity;
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
  return (
    <div className="space-y-5 p-4">
      {groupActivityDays(activity.items).map((group) => (
        <section key={group.key} className="space-y-3">
          <h3 className="text-muted-foreground text-xs font-medium">
            {new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(group.day)}
          </h3>
          <ol className="space-y-4">
            {group.items.map((item) => {
              const threadId = activityThreadId(item);
              const version = activityVersionId(item);
              const actor = item.actor;
              const actorName = actor.kind === 'system' ? t('systemActor') : actor.name;
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
              return (
                <li key={item.id} className="flex items-start gap-2.5" data-activity-id={item.id}>
                  {actor.kind === 'user' ? (
                    <UserAvatar email="" name={actorName} size="sm" />
                  ) : (
                    <EntityAvatar
                      label={actorName}
                      icon={actor.kind === 'session' ? RobotIcon : ClockCounterClockwiseIcon}
                      size="sm"
                    />
                  )}
                  <div className="min-w-0 flex-1 space-y-1 text-sm">
                    <p className="break-words">
                      {actor.kind === 'session' ? (
                        <Link
                          href={`/projects/${projectId}/sessions/${actor.id}`}
                          className="font-medium hover:underline"
                        >
                          {actorName}
                        </Link>
                      ) : (
                        <span className="font-medium">{actorName}</span>
                      )}{' '}
                      {version || threadId ? (
                        <button
                          type="button"
                          className="text-foreground focus-visible:ring-ring rounded-sm text-left break-words hover:underline focus-visible:ring-2 focus-visible:outline-none"
                          aria-label={label}
                          onClick={() =>
                            version ? onOpenVersion(version) : onFocusThread(threadId!)
                          }
                        >
                          {verb}
                        </button>
                      ) : (
                        verb
                      )}
                    </p>
                    {typeof object === 'string' && object ? (
                      <p className="text-muted-foreground text-xs break-words">{object}</p>
                    ) : null}
                    <time
                      className="text-muted-foreground block text-xs tabular-nums"
                      dateTime={item.at}
                      title={new Intl.DateTimeFormat(locale, {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      }).format(new Date(item.at))}
                    >
                      {new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(
                        new Date(item.at),
                      )}
                    </time>
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
          {t('loadMore')}
        </Button>
      ) : null}
      {activity.olderVersions ? (
        <p className="text-muted-foreground text-xs">{t('olderSaves')}</p>
      ) : null}
    </div>
  );
}

'use client';

import { UnifiedMarkdown } from '@/components/markdown/unified-markdown';
import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import { getPublicSessionShareMessages, type PublicSessionTranscriptMessage } from '@kortix/sdk';
import { ChatTextIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';

import {
  describeShareError,
  savedCopyTimestamp,
  toShareLoadError,
  visibleTranscriptMessages,
} from './public-transcript';

/**
 * The read-only conversation behind a `transcript` share.
 *
 * Anonymous: `getPublicSessionShareMessages` sends no Authorization header and
 * the API returns a sanitized digest (message text, tool names, file names; no
 * tool input or output, no file contents, no reasoning). The route token is a
 * valid `:ref` for that read, so nothing is resolved client-side.
 */
export function PublicTranscriptShareView({ token }: { token: string }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const t = useTranslations('hardcodedUi.publicTranscriptShare');
  const locale = useLocale();

  const query = useQuery({
    queryKey: ['public-session-transcript', token],
    queryFn: () => getPublicSessionShareMessages(token),
    // 404 and 410 are settled answers. 503 (nothing saved yet) gets a Retry
    // button instead of three silent automatic attempts.
    retry: false,
    refetchOnWindowFocus: false,
  });

  if (query.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loading className="text-muted-foreground size-5" />
      </div>
    );
  }

  if (query.isError || !query.data) {
    const { title, description } = describeShareError(
      query.error ? toShareLoadError(query.error) : null,
      tI18nComplete,
      t('loadFailedDescription'),
    );
    return (
      <div className="flex h-full items-center justify-center px-4">
        <ErrorState
          size="sm"
          title={title}
          description={description}
          action={
            <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
              {tI18nComplete.raw('textd8b8392e2c54')}
            </Button>
          }
        />
      </div>
    );
  }

  const transcript = query.data;
  const messages = visibleTranscriptMessages(transcript);
  const savedAt = savedCopyTimestamp(transcript);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl space-y-6 px-4 py-10 pb-20">
        {savedAt ? (
          <p className="text-muted-foreground text-center text-xs">
            {t('savedCopy', {
              date: new Intl.DateTimeFormat(locale, {
                dateStyle: 'medium',
                timeStyle: 'short',
              }).format(new Date(savedAt)),
            })}
          </p>
        ) : null}
        {!transcript.available ? (
          <EmptyState
            size="sm"
            icon={ChatTextIcon}
            title={t('unavailable')}
            // Fixed copy: `reason` is the API's internal diagnosis (sandbox and
            // runtime state), not something an anonymous visitor should read.
            description={t('unavailableDescription')}
            action={
              <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
                {tI18nComplete.raw('textd8b8392e2c54')}
              </Button>
            }
          />
        ) : messages.length === 0 ? (
          <EmptyState size="sm" icon={ChatTextIcon} title={t('empty')} />
        ) : (
          messages.map((message, index) => (
            <TranscriptMessage
              key={`${message.role}-${message.created ?? ''}-${index}`}
              message={message}
            />
          ))
        )}
      </div>
    </div>
  );
}

function TranscriptMessage({ message }: { message: PublicSessionTranscriptMessage }) {
  const isUser = message.role === 'user';
  return (
    <div className={cn('flex', isUser && 'justify-end')}>
      <div
        className={cn(
          'min-w-0 wrap-break-word',
          isUser ? 'bg-sidebar max-w-4/5 rounded-lg px-3.5 py-2.5' : 'w-full',
        )}
      >
        {/* `untrusted`: an anonymous visitor reads this. Remote images wait
            for a click, so opening the link sends no request to a host the
            conversation chose, and agent setup links stay plain links. */}
        <UnifiedMarkdown content={message.text} trust="untrusted" />
      </div>
    </div>
  );
}

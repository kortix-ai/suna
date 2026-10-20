'use client';

import { UnifiedMarkdown } from '@/components/markdown/unified-markdown';
import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import { StepLabelRow } from '@/features/session/turn/activity-step';
import { UserMessageBubble } from '@/features/session/turn/user-message';
import { getPublicSessionShareMessages, type PublicSessionTranscriptMessage } from '@kortix/sdk';
import { ChatTextIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';

import {
  describeShareError,
  savedCopyTimestamp,
  toShareLoadError,
  transcriptToolSteps,
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
  if (message.role === 'user') return <SharedUserMessage text={message.text} />;
  const steps = transcriptToolSteps(message);
  return (
    <div className="min-w-0 space-y-3 wrap-break-word">
      {/* The digest has no tool input or output, so each call is the session's
          label row (`StepLabelRow`), not its expandable tool card. */}
      {steps.length > 0 ? (
        <div className="space-y-2">
          {steps.map((step, index) => (
            <StepLabelRow key={index} label={step} running={false} />
          ))}
        </div>
      ) : null}
      {/* `untrusted`: an anonymous visitor reads this. Remote images wait
          for a click, so opening the link sends no request to a host the
          conversation chose, and agent setup links stay plain links. The
          agent's replies render generative UI, as in the session. */}
      {message.text.trim() ? (
        <UnifiedMarkdown content={message.text} trust="untrusted" genui />
      ) : null}
    </div>
  );
}

/** The session's own bubble: the prompt is plain text with its line breaks,
 *  never markdown, clamped at 200px behind "Show more" (`UserMessage`). */
function SharedUserMessage({ text }: { text: string }) {
  const textId = useId();
  const textRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [canExpand, setCanExpand] = useState(false);

  useEffect(() => {
    const el = textRef.current;
    if (!el || expanded) return;
    const measure = () => setCanExpand(el.scrollHeight > el.clientHeight + 2);
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, expanded]);

  return (
    <div className="flex justify-end">
      <div className="flex max-w-4/5 min-w-0 justify-end">
        <UserMessageBubble
          canExpand={canExpand}
          expanded={expanded}
          onToggle={() => setExpanded((value) => !value)}
          textId={textId}
          textRef={textRef}
        >
          {text}
        </UserMessageBubble>
      </div>
    </div>
  );
}

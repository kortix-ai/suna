import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { Button } from '@/components/ui/button';
import { getTranslations, getLocale } from '@/i18n/get-translations';
import { getServerPublicEnv } from '@/lib/public-env-server';
import { getPublicSessionShareMessages } from '@kortix/sdk';
import { runWithKortix } from '@kortix/sdk/server';

import {
  describeShareError,
  savedCopyTimestamp,
  visibleTranscriptMessages,
} from '@/app/[locale]/(public)/share/session/[token]/public-transcript';
import { TranscriptMessage } from '@/app/[locale]/(public)/share/session/[token]/transcript-message';
import { embedFrameClasses, loadEmbedTranscript, parseEmbedLayout } from './embed-shared';

// Every load resolves the share's current state (revoked links must stop
// working the moment they are revoked, not when a cache says so).
export const dynamic = 'force-dynamic';

interface EmbedPageProps {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ layout?: string }>;
}

/**
 * The embeddable chat widget: a chromeless, read-only conversation keyed to a
 * `transcript` public share token (`kps_…`), the same anonymous authorization
 * the `/share/session/:token` page uses — no parallel session protocol, no
 * second credential.
 *
 * The fetch happens server-side on purpose: a host page frames this URL, and
 * a browser inside a third-party frame cannot call the API cross-origin (the
 * CORS allowlist is ours). SSR is also why the widget needs no JavaScript of
 * its own to show the conversation.
 *
 * The rendered snapshot is the same one the share page shows: the API answers
 * from the live sandbox when the session runs and from the saved transcript
 * when it does not.
 */
export default async function EmbedChatTokenPage({ params, searchParams }: EmbedPageProps) {
  const [{ token }, query, t, tI18nComplete, locale] = await Promise.all([
    params,
    searchParams,
    getTranslations('hardcodedUi.publicTranscriptShare'),
    getTranslations('hardcodedUi.i18nComplete'),
    getLocale(),
  ]);

  const layout = parseEmbedLayout(query.layout);
  const frame = embedFrameClasses(layout);

  const backendUrl = getServerPublicEnv().BACKEND_URL;
  const result = await loadEmbedTranscript(
    backendUrl
      ? (shareToken) =>
          // Scoped, never a process-global config: concurrent renders must not
          // see each other's backend. The transcript read is anonymous, so the
          // token getter resolves nothing.
          runWithKortix({ backendUrl, getToken: async () => null }, () =>
            getPublicSessionShareMessages(shareToken),
          )
      // No server-side backend URL: not an API answer, the generic failure.
      : null,
    token,
  );

  if (result.kind === 'error') {
    const { title, description } = describeShareError(
      result.loadError,
      tI18nComplete,
      t('loadFailedDescription'),
    );
    return (
      <main className={frame.root}>
        <div className="flex h-full items-center justify-center px-4">
          {/* An embed cannot own its host's navigation, so "try again" is a
              plain reload, offered only where retrying can change the answer
              (503: the session may save its transcript later). 404 and 410
              are settled rejections of the embed credential itself. */}
          <ErrorState
            size="sm"
            title={title}
            description={description}
            action={
              result.loadError?.status === 503 ? (
                <Button variant="outline" size="sm" asChild>
                  <a href="">{tI18nComplete.raw('textd8b8392e2c54')}</a>
                </Button>
              ) : undefined
            }
          />
        </div>
      </main>
    );
  }

  const transcript = result.transcript;
  const messages = visibleTranscriptMessages(transcript);
  const savedAt = savedCopyTimestamp(transcript);

  return (
    <main className={frame.root}>
      <div className={frame.scroll}>
        <div className={frame.column}>
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
              title={t('unavailable')}
              // Fixed copy: `reason` is the API's internal diagnosis (sandbox
              // and runtime state), not something a host's visitor should read.
              description={t('unavailableDescription')}
            />
          ) : messages.length === 0 ? (
            <EmptyState size="sm" title={t('empty')} />
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
    </main>
  );
}

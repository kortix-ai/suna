'use client';

import { shouldIgnoreBrowserRuntimeNoise } from '@/lib/browser-error-noise';
import { truncate as sharedTruncate } from '@/lib/utils/string';
import * as Sentry from '@sentry/nextjs';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

type Diag = {
  url: string;
  timestampUtc: string;
  timezone: string;
  userAgent: string;
  language: string;
  viewport: string;
  online: string;
  env: string;
  sentryEventId: string;
  errorName: string;
  errorDigest: string;
  errorStack: string;
};

const EMPTY = '—';

function truncate(value: string, max: number): string {
  return value ? sharedTruncate(value, max) : EMPTY;
}

export function SystemFaultView({
  error,
  reset,
  report = true,
}: {
  error: Error & { digest?: string };
  reset?: () => void;
  report?: boolean;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const [diag, setDiag] = useState<Diag | null>(null);

  useEffect(() => {
    const loc = typeof window !== 'undefined' ? window.location : undefined;
    const nav = typeof navigator !== 'undefined' ? navigator : undefined;
    const doc = typeof document !== 'undefined' ? document : undefined;
    const viewport =
      typeof window !== 'undefined'
        ? `${window.innerWidth}×${window.innerHeight}@${window.devicePixelRatio}x`
        : EMPTY;
    const timezone =
      typeof Intl !== 'undefined'
        ? Intl.DateTimeFormat().resolvedOptions().timeZone || EMPTY
        : EMPTY;

    let eventId = EMPTY;
    if (report && !shouldIgnoreBrowserRuntimeNoise({ message: error.message, error })) {
      console.error('[Kortix System Fault]', error);
      eventId =
        Sentry.captureException(error, {
          tags: { area: 'global-error-boundary' },
          extra: {
            href: loc?.href,
            pathname: loc?.pathname,
            search: loc?.search,
            hash: loc?.hash,
            referrer: doc?.referrer,
            userAgent: nav?.userAgent,
            viewport,
          },
        }) || EMPTY;
    }

    const now = new Date();
    setDiag({
      url: loc?.href || EMPTY,
      timestampUtc: now.toISOString(),
      timezone,
      userAgent: nav?.userAgent || EMPTY,
      language: nav?.language || EMPTY,
      viewport,
      online: typeof nav?.onLine === 'boolean' ? (nav.onLine ? 'yes' : 'no') : EMPTY,
      env: process.env.NEXT_PUBLIC_KORTIX_ENV || 'dev',
      sentryEventId: eventId,
      errorName: error.name || 'Error',
      errorDigest: error.digest || EMPTY,
      errorStack: (error.stack || EMPTY).split('\n').slice(0, 6).join('\n'),
    });
  }, [error, report]);

  const errorMessage = error.message
    ? truncate(error.message, 320)
    : 'An unrecoverable error occurred.';

  const envLine = diag
    ? [
        diag.env,
        diag.viewport,
        diag.language,
        diag.online === 'yes' ? 'online' : diag.online === 'no' ? 'offline' : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : EMPTY;

  return (
    <div className="fault-root">
      <div className="fault-overlay fault-scan" aria-hidden="true" />
      <div className="fault-overlay fault-vignette" aria-hidden="true" />

      <main className="fault-container">
        <header className="fault-header">
          <svg
            className="fault-logo"
            width="26"
            height="22"
            viewBox="0 0 30 25"
            fill="white"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
          >
            <path d="M25.56 24.92H29.83C29.83 19.63 26.94 15 22.62 12.46C26.94 9.91 29.83 5.29 29.83 0H25.56C25.56 5 21.89 9.19 17.07 10.17V0H12.8V10.17C7.95 9.2 4.3 5.02 4.3 0H0.04C0.04 5.29 2.93 9.91 7.25 12.46C2.93 15 0.04 19.63 0.04 24.92H4.3C4.3 19.9 7.95 15.71 12.8 14.75V24.92H17.07V14.75C21.91 15.71 25.56 19.9 25.56 24.92Z" />
          </svg>
          <h1 className="fault-title">
            {tI18nHardcoded.raw('autoComponentsCommonSystemFaultJsxTextSystemFault1e929d97')}
          </h1>
          <p className="fault-subtitle">
            {tI18nHardcoded.raw('autoComponentsCommonSystemFaultJsxTextTheAppFailedTo6f1872d0')}
          </p>
        </header>

        <section className="fault-card" aria-label="Error">
          <div className="fault-card-head">
            <span className="fault-eyebrow">Error</span>
            <span className="fault-error-name">{diag?.errorName || 'Error'}</span>
          </div>
          <div className="fault-error-msg">{errorMessage}</div>
          {diag?.errorStack && diag.errorStack !== EMPTY && (
            <details className="fault-stack">
              <summary>Stack</summary>
              <pre>{diag.errorStack}</pre>
            </details>
          )}
        </section>

        <section className="fault-card" aria-label="Diagnostics">
          <div className="fault-card-head">
            <span className="fault-eyebrow">Diagnostics</span>
          </div>
          <dl className="fault-diag">
            <dt>url</dt>
            <dd className="mono">{diag?.url || EMPTY}</dd>
            <dt>digest</dt>
            <dd className="mono">{diag?.errorDigest || EMPTY}</dd>
            <dt>event</dt>
            <dd className="mono">{diag?.sentryEventId || EMPTY}</dd>
            <dt>env</dt>
            <dd>{envLine}</dd>
            <dt>time</dt>
            <dd className="mono">{diag ? `${diag.timestampUtc} (${diag.timezone})` : EMPTY}</dd>
            <dt>agent</dt>
            <dd className="mono">{diag ? truncate(diag.userAgent, 180) : EMPTY}</dd>
          </dl>
        </section>

        <div className="fault-actions">
          {reset ? (
            <button type="button" className="fault-btn primary" onClick={reset}>
              {tI18nHardcoded.raw('autoComponentsCommonSystemFaultJsxTextTryAgaineb14b1c9')}
            </button>
          ) : (
            // eslint-disable-next-line @next/next/no-html-link-for-pages
            <a className="fault-btn primary" href="/">
              {tI18nHardcoded.raw('autoComponentsCommonSystemFaultJsxTextReturnHome8e955e59')}
            </a>
          )}
          <button
            type="button"
            className="fault-btn secondary"
            onClick={() => {
              if (typeof window !== 'undefined') window.location.reload();
            }}
          >
            Reload
          </button>
        </div>

        <p className="fault-support">
          {tI18nHardcoded.raw(
            'autoComponentsCommonSystemFaultJsxTextIfThisPersistsContact38b14ac8',
          )}
          <a href="mailto:support@kortix.ai">
            {tI18nHardcoded.raw('autoComponentsCommonSystemFaultJsxTextSupportKortixAi314bf854')}
          </a>
        </p>
      </main>
    </div>
  );
}

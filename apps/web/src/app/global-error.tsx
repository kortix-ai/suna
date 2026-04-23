/* eslint-disable @next/next/no-html-link-for-pages */
'use client';

import { useEffect, useState } from 'react';
import * as Sentry from '@sentry/nextjs';
import { shouldIgnoreBrowserRuntimeNoise } from '@/lib/browser-error-noise';

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
  if (!value) return EMPTY;
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

const STYLES = `
  :root { color-scheme: dark; }
  html, body { margin: 0; padding: 0; height: 100%; }
  body.fault-body {
    min-height: 100dvh;
    background-color: #0e0e0e;
    color: #e5e5e5;
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    display: flex;
    align-items: safe center;
    justify-content: safe center;
    overflow-x: hidden;
    overflow-y: auto;
    position: relative;
  }
  .fault-overlay {
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 1;
  }
  .fault-scan {
    opacity: 0.04;
    background-image: repeating-linear-gradient(
      0deg,
      transparent,
      transparent 2px,
      rgba(255, 255, 255, 0.03) 2px,
      rgba(255, 255, 255, 0.03) 4px
    );
  }
  .fault-vignette {
    background: radial-gradient(
      ellipse at center,
      transparent 45%,
      rgba(0, 0, 0, 0.55) 100%
    );
  }
  .fault-container {
    position: relative;
    z-index: 2;
    width: 100%;
    max-width: 520px;
    padding: 24px 18px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    box-sizing: border-box;
  }
  .fault-header {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    text-align: center;
    margin-bottom: 2px;
  }
  .fault-logo {
    opacity: 0.9;
  }
  .fault-title {
    margin: 0;
    font-size: 18px;
    font-weight: 500;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: #f3f3f3;
    letter-spacing: -0.01em;
  }
  .fault-subtitle {
    margin: 0;
    font-size: 12px;
    line-height: 1.5;
    color: rgba(255, 255, 255, 0.45);
    max-width: 340px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  .fault-card {
    background: rgba(255, 255, 255, 0.025);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 10px;
    padding: 10px 12px;
    text-align: left;
  }
  .fault-card-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 4px;
  }
  .fault-eyebrow {
    font-size: 9.5px;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: rgba(255, 255, 255, 0.32);
    font-weight: 600;
  }
  .fault-error-name {
    font-size: 10px;
    color: rgba(255, 255, 255, 0.42);
  }
  .fault-error-msg {
    font-size: 13px;
    color: rgba(255, 255, 255, 0.88);
    line-height: 1.45;
    word-break: break-word;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  .fault-stack {
    margin-top: 8px;
  }
  .fault-stack summary {
    cursor: pointer;
    font-size: 10px;
    color: rgba(255, 255, 255, 0.4);
    user-select: none;
    list-style: none;
    outline: none;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 0;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .fault-stack summary::-webkit-details-marker { display: none; }
  .fault-stack summary::before {
    content: "›";
    display: inline-block;
    transform: rotate(0deg);
    transition: transform 0.15s ease;
    font-size: 12px;
    line-height: 1;
  }
  .fault-stack[open] summary::before {
    transform: rotate(90deg);
  }
  .fault-stack pre {
    margin: 6px 0 0;
    padding: 8px 10px;
    background: rgba(0, 0, 0, 0.4);
    border: 1px solid rgba(255, 255, 255, 0.05);
    border-radius: 6px;
    font-size: 10px;
    line-height: 1.5;
    color: rgba(255, 255, 255, 0.55);
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 140px;
    overflow: auto;
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, monospace;
  }
  .fault-diag {
    margin: 0;
    display: grid;
    grid-template-columns: 62px minmax(0, 1fr);
    row-gap: 1px;
    column-gap: 10px;
  }
  .fault-diag dt {
    font-size: 9.5px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: rgba(255, 255, 255, 0.3);
    padding: 3px 0;
    font-weight: 500;
    align-self: start;
  }
  .fault-diag dd {
    margin: 0;
    min-width: 0;
    font-size: 11px;
    color: rgba(255, 255, 255, 0.7);
    padding: 3px 0;
    word-break: break-all;
    line-height: 1.5;
  }
  .fault-diag dd.mono {
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, monospace;
  }
  .fault-actions {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    margin-top: 2px;
  }
  .fault-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 11px 16px;
    border-radius: 999px;
    font-size: 13px;
    font-weight: 500;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    cursor: pointer;
    text-decoration: none;
    box-sizing: border-box;
    transition: background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease;
    border: 1px solid transparent;
    white-space: nowrap;
  }
  .fault-btn.primary {
    background: rgba(255, 255, 255, 0.92);
    color: #111;
  }
  .fault-btn.primary:hover {
    background: #fff;
  }
  .fault-btn.secondary {
    background: transparent;
    color: rgba(255, 255, 255, 0.72);
    border-color: rgba(255, 255, 255, 0.14);
  }
  .fault-btn.secondary:hover {
    color: rgba(255, 255, 255, 0.95);
    border-color: rgba(255, 255, 255, 0.28);
  }
  .fault-support {
    font-size: 11px;
    color: rgba(255, 255, 255, 0.35);
    text-align: center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  .fault-support a {
    color: rgba(255, 255, 255, 0.6);
    text-decoration: underline;
    text-decoration-color: rgba(255, 255, 255, 0.2);
  }
  @media (max-width: 420px) {
    .fault-actions { grid-template-columns: 1fr; }
    .fault-diag { grid-template-columns: 54px minmax(0, 1fr); }
  }
  @media (max-height: 640px) {
    .fault-container { padding: 14px 18px; gap: 10px; }
    .fault-subtitle { display: none; }
    .fault-header { gap: 4px; margin-bottom: 0; }
  }
`;

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [diag, setDiag] = useState<Diag | null>(null);

  useEffect(() => {
    if (shouldIgnoreBrowserRuntimeNoise({ message: error.message, error })) {
      return;
    }
    console.error('[Kortix Global Error]', error);

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

    const eventId = Sentry.captureException(error, {
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
    });

    const now = new Date();
    setDiag({
      url: loc?.href || EMPTY,
      timestampUtc: now.toISOString(),
      timezone,
      userAgent: nav?.userAgent || EMPTY,
      language: nav?.language || EMPTY,
      viewport,
      online: typeof nav?.onLine === 'boolean' ? (nav.onLine ? 'yes' : 'no') : EMPTY,
      env:
        process.env.NEXT_PUBLIC_KORTIX_ENV ||
        process.env.NEXT_PUBLIC_ENV_MODE ||
        'dev',
      sentryEventId: eventId || EMPTY,
      errorName: error.name || 'Error',
      errorDigest: error.digest || EMPTY,
      errorStack: (error.stack || EMPTY).split('\n').slice(0, 6).join('\n'),
    });
  }, [error]);

  const errorMessage = error.message
    ? truncate(error.message, 320)
    : 'An unrecoverable error occurred.';

  const envLine = diag
    ? [diag.env, diag.viewport, diag.language, diag.online === 'yes' ? 'online' : diag.online === 'no' ? 'offline' : null]
        .filter(Boolean)
        .join(' · ')
    : EMPTY;

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>System Fault</title>
        <style dangerouslySetInnerHTML={{ __html: STYLES }} />
      </head>
      <body className="fault-body">
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
              <path d="M25.5614 24.916H29.8268C29.8268 19.6306 26.9378 15.0039 22.6171 12.4587C26.9377 9.91355 29.8267 5.28685 29.8267 0.00146484H25.5613C25.5613 5.00287 21.8906 9.18692 17.0654 10.1679V0.00146484H12.8005V10.1679C7.9526 9.20401 4.3046 5.0186 4.3046 0.00146484H0.0391572C0.0391572 5.28685 2.92822 9.91355 7.24884 12.4587C2.92818 15.0039 0.0390625 19.6306 0.0390625 24.916H4.30451C4.30451 19.8989 7.95259 15.7135 12.8005 14.7496V24.9206H17.0654V14.7496C21.9133 15.7134 25.5614 19.8989 25.5614 24.916Z" />
            </svg>
            <h1 className="fault-title">System Fault</h1>
            <p className="fault-subtitle">
              The app failed to load. Our team has been notified — the details
              below help support reproduce your session.
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
              <dd className="mono">
                {diag ? `${diag.timestampUtc} (${diag.timezone})` : EMPTY}
              </dd>
              <dt>agent</dt>
              <dd className="mono">{diag ? truncate(diag.userAgent, 180) : EMPTY}</dd>
            </dl>
          </section>

          <div className="fault-actions">
            <a className="fault-btn primary" href="/">
              Return Home
            </a>
            <button
              type="button"
              className="fault-btn secondary"
              onClick={() => window.location.reload()}
            >
              Reload
            </button>
          </div>

          <p className="fault-support">
            If this persists, contact{' '}
            <a href="mailto:support@kortix.ai">support@kortix.ai</a>
          </p>
        </main>
      </body>
    </html>
  );
}

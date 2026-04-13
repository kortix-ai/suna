/* eslint-disable @next/next/no-html-link-for-pages */
'use client';

import { useEffect, useState } from 'react';
import * as Sentry from '@sentry/nextjs';
import { shouldIgnoreBrowserRuntimeNoise } from '@/lib/browser-error-noise';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [timestamp, setTimestamp] = useState('');

  useEffect(() => {
    if (shouldIgnoreBrowserRuntimeNoise({ message: error.message, error })) {
      return;
    }
    console.error('[Kortix Global Error]', error);
    // Report to Better Stack via Sentry SDK
    Sentry.captureException(error, {
      tags: {
        area: 'global-error-boundary',
      },
      extra: {
        pathname: typeof window !== 'undefined' ? window.location.pathname : undefined,
        search: typeof window !== 'undefined' ? window.location.search : undefined,
        href: typeof window !== 'undefined' ? window.location.href : undefined,
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
      },
    });
  }, [error]);

  useEffect(() => {
    setTimestamp(new Date().toISOString());
  }, []);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          padding: 0,
          minHeight: '100dvh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily:
            'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
          backgroundColor: '#111',
          color: '#e0e0e0',
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        {/* Scanline overlay */}
        <div
          style={{
            position: 'fixed',
            inset: 0,
            pointerEvents: 'none',
            zIndex: 1,
            opacity: 0.04,
            backgroundImage:
              'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(255,255,255,0.03) 2px, rgba(255,255,255,0.03) 4px)',
            backgroundSize: '100% 4px',
          }}
        />

        {/* Noise texture */}
        <div
          style={{
            position: 'fixed',
            inset: 0,
            pointerEvents: 'none',
            zIndex: 1,
            opacity: 0.06,
            backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,
            backgroundRepeat: 'repeat',
            backgroundSize: '256px 256px',
          }}
        />

        {/* Vignette */}
        <div
          style={{
            position: 'fixed',
            inset: 0,
            pointerEvents: 'none',
            zIndex: 1,
            background:
              'radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,0.4) 100%)',
          }}
        />

        <div
          style={{
            position: 'relative',
            zIndex: 2,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '32px',
            maxWidth: '480px',
            padding: '24px',
            textAlign: 'center',
          }}
        >
          {/* Kortix symbol — inline SVG */}
          <svg
            width="40"
            height="33"
            viewBox="0 0 30 25"
            fill="white"
            fillOpacity="1"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path d="M25.5614 24.916H29.8268C29.8268 19.6306 26.9378 15.0039 22.6171 12.4587C26.9377 9.91355 29.8267 5.28685 29.8267 0.00146484H25.5613C25.5613 5.00287 21.8906 9.18692 17.0654 10.1679V0.00146484H12.8005V10.1679C7.9526 9.20401 4.3046 5.0186 4.3046 0.00146484H0.0391572C0.0391572 5.28685 2.92822 9.91355 7.24884 12.4587C2.92818 15.0039 0.0390625 19.6306 0.0390625 24.916H4.30451C4.30451 19.8989 7.95259 15.7135 12.8005 14.7496V24.9206H17.0654V14.7496C21.9133 15.7134 25.5614 19.8989 25.5614 24.916Z" />
          </svg>

          {/* Title */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <h1
              style={{
                margin: 0,
                fontSize: '24px',
                fontWeight: 400,
                fontFamily:
                  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                color: '#e8e8e8',
                letterSpacing: '-0.02em',
              }}
            >
              System Fault
            </h1>
            <p
              style={{
                margin: 0,
                fontSize: '14px',
                lineHeight: 1.6,
                color: 'rgba(255,255,255,0.4)',
              }}
            >
              A critical error occurred that prevented the application from loading.
              Our team has been notified automatically.
            </p>
          </div>

          {/* Error details */}
          <div
            style={{
              width: '100%',
              padding: '16px',
              borderRadius: '12px',
              border: '1px solid rgba(255,255,255,0.08)',
              backgroundColor: 'rgba(255,255,255,0.03)',
              textAlign: 'left',
            }}
          >
            <div
              style={{
                fontSize: '11px',
                textTransform: 'uppercase',
                letterSpacing: '0.1em',
                color: 'rgba(255,255,255,0.25)',
                marginBottom: '8px',
              }}
            >
              Error Details
            </div>
            <div
              style={{
                fontSize: '13px',
                color: 'rgba(255,255,255,0.55)',
                wordBreak: 'break-word',
                lineHeight: 1.5,
              }}
            >
              {error.message && error.message.length < 300
                ? error.message
                : 'An unrecoverable error occurred.'}
            </div>
            {error.digest && (
              <div
                style={{
                  marginTop: '8px',
                  fontSize: '11px',
                  color: 'rgba(255,255,255,0.2)',
                }}
              >
                ref: {error.digest}
              </div>
            )}
          </div>

          {/* Support contact */}
          <div
            style={{
              fontSize: '12px',
              color: 'rgba(255,255,255,0.3)',
              textAlign: 'center',
            }}
          >
            If this persists, contact{' '}
            <a
              href="mailto:support@kortix.ai"
              style={{
                color: 'rgba(255,255,255,0.5)',
                textDecoration: 'underline',
                textDecorationColor: 'rgba(255,255,255,0.2)',
              }}
            >
              support@kortix.ai
            </a>
          </div>

          {/* Action buttons — stacked */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', width: '100%' }}>
            <a
              href="/"
              style={{
                padding: '14px 24px',
                borderRadius: '999px',
                border: 'none',
                backgroundColor: 'rgba(255,255,255,0.9)',
                color: '#111',
                fontSize: '14px',
                fontWeight: 500,
                fontFamily:
                  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                cursor: 'pointer',
                transition: 'background-color 0.15s ease',
                textDecoration: 'none',
                textAlign: 'center',
                display: 'block',
                boxSizing: 'border-box',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = 'rgba(255,255,255,1)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.9)';
              }}
            >
              Return Home
            </a>
            <button
              onClick={() => window.location.reload()}
              style={{
                padding: '14px 24px',
                borderRadius: '999px',
                border: '1px solid rgba(255,255,255,0.12)',
                backgroundColor: 'transparent',
                color: 'rgba(255,255,255,0.6)',
                fontSize: '14px',
                fontWeight: 500,
                fontFamily:
                  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                cursor: 'pointer',
                transition: 'border-color 0.15s ease, color 0.15s ease',
                boxSizing: 'border-box',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = 'rgba(255,255,255,0.25)';
                e.currentTarget.style.color = 'rgba(255,255,255,0.8)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = 'rgba(255,255,255,0.12)';
                e.currentTarget.style.color = 'rgba(255,255,255,0.6)';
              }}
            >
              Reload
            </button>
          </div>

          {/* Timestamp */}
          <div
            suppressHydrationWarning
            style={{
              fontSize: '11px',
              color: 'rgba(255,255,255,0.15)',
              letterSpacing: '0.05em',
            }}
          >
            {timestamp || '---- -- --T--:--:--.---Z'}
          </div>
        </div>


      </body>
    </html>
  );
}

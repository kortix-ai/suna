'use client';

import { useEffect } from 'react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Global error:', error);
  }, [error]);

  return (
    <html>
      <body>
        <div
          style={{
            minHeight: '100dvh',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily:
              '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
            padding: '1.5rem',
            backgroundColor: '#0a0a0a',
            color: '#fafafa',
          }}
        >
          <div
            style={{
              maxWidth: '28rem',
              width: '100%',
              textAlign: 'center',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '1.5rem',
            }}
          >
            <h1
              style={{
                fontSize: '1.875rem',
                fontWeight: 400,
                letterSpacing: '-0.025em',
              }}
            >
              Something went wrong
            </h1>
            <p style={{ fontSize: '0.875rem', color: 'rgba(250,250,250,0.6)' }}>
              An unexpected error occurred. Please try again.
            </p>
            <button
              onClick={() => reset()}
              style={{
                width: '100%',
                height: '3rem',
                borderRadius: '0.5rem',
                border: 'none',
                backgroundColor: '#fafafa',
                color: '#0a0a0a',
                fontSize: '0.875rem',
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              Try Again
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}

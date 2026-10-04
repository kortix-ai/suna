'use client';

import type { ReactNode } from 'react';

import { KortixLogo } from '@/components/ui/kortix-logo';
import Loading from '@/components/ui/loading';
import { ErrorStrip } from '@/features/auth/auth-primitives';

/**
 * Deliver a message to the window that opened this popup. Silent when there is
 * no opener (a directly-opened popup) or it has navigated away.
 */
export function postToOpener(message: unknown): void {
  try {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage(message, window.location.origin);
    }
  } catch (err) {
    console.error('Failed to post message to opener:', err);
  }
}

/**
 * The frame both GitHub popups render: centered card, logo, title, and the
 * loading/processing row — or the error strip with optional extra actions
 * (the sign-in popup's Close button).
 */
export function AuthPopupShell({
  title,
  status,
  errorMessage,
  errorText,
  processingText,
  waitingText,
  errorActions,
}: {
  title: string;
  status: 'loading' | 'processing' | 'error';
  errorMessage: string;
  errorText: string;
  processingText: string;
  waitingText: string;
  errorActions?: ReactNode;
}) {
  return (
    <main className="bg-background flex min-h-svh flex-col items-center justify-center px-6">
      <div className="w-full max-w-[320px]">
        <KortixLogo variant="icon" size={22} className="text-foreground" />
        <h1 className="text-foreground mt-6 text-2xl font-medium tracking-tight">{title}</h1>

        <div className="mt-6">
          {status === 'error' ? (
            <>
              <ErrorStrip message={errorMessage || errorText} />
              {errorActions}
            </>
          ) : (
            <div className="text-muted-foreground flex items-center gap-2 text-sm">
              <Loading className="text-muted-foreground size-4 shrink-0" />
              <span>{status === 'processing' ? processingText : waitingText}</span>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

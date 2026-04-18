'use client';

import { useEffect } from 'react';
import { shouldIgnoreBrowserRuntimeNoise } from '@/lib/browser-error-noise';

export function BrowserNoiseGuard() {
  useEffect(() => {
    const handleError = (event: ErrorEvent) => {
      if (!shouldIgnoreBrowserRuntimeNoise({
        message: event.message,
        filename: event.filename,
        error: event.error,
      })) {
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation?.();
    };

    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      if (!shouldIgnoreBrowserRuntimeNoise({ reason: event.reason })) {
        return;
      }

      event.preventDefault();
    };

    window.addEventListener('error', handleError);
    window.addEventListener('unhandledrejection', handleUnhandledRejection);

    return () => {
      window.removeEventListener('error', handleError);
      window.removeEventListener('unhandledrejection', handleUnhandledRejection);
    };
  }, []);

  return null;
}

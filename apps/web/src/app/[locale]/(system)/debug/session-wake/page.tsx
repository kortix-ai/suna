'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';

import { SessionConnectingBanner, SessionStartingLoader } from '@/features/session/session-starting-loader';

/**
 * /debug/session-wake
 *
 * The note a session shows while the server waits to retry a wake that did
 * not finish (`runtime_wake_cooldown`): a near retry counts down, and a retry
 * clock that is not believable (here, a century away) shows no countdown. A
 * cold restore once showed "about 99 years" here. Not linked from anywhere.
 */
function cooldown(nextRetryAt: string) {
  return {
    category: 'sandbox-provider' as const,
    message: 'The runtime did not start.',
    retryable: true,
    evidence: { check: 'start_timeout', observed_at: null, error: null, attempts: 1, next_retry_at: nextRetryAt },
  };
}

export default function DebugSessionWakePage() {
  const [qc] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  const [near] = useState(() => new Date(Date.now() + 120_000).toISOString());
  const far = '2125-10-05T00:18:00.000Z';
  return (
    <QueryClientProvider client={qc}>
      <main className="bg-background text-foreground flex min-h-screen flex-col gap-6 p-6">
        <section id="loader-near" className="border-border h-48 rounded-md border">
          <SessionStartingLoader stage="starting" delayMs={0} reason="runtime_wake_cooldown" failure={cooldown(near)} />
        </section>
        <section id="loader-far" className="border-border h-48 rounded-md border">
          <SessionStartingLoader stage="starting" delayMs={0} reason="runtime_wake_cooldown" failure={cooldown(far)} />
        </section>
        <section id="banner-near" className="border-border relative h-16 rounded-md border">
          <SessionConnectingBanner stage="starting" reason="runtime_wake_cooldown" failure={cooldown(near)} />
        </section>
      </main>
    </QueryClientProvider>
  );
}

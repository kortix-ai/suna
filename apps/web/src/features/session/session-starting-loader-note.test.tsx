import {
  SessionConnectingBanner,
  SessionStartingLoader,
  sessionWakeStatusNote,
} from '@/features/session/session-starting-loader';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';

const NOTE = 'Still waking — restarting the runtime (attempt 3)';

function render(node: React.ReactNode) {
  const client = new QueryClient();
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
      <QueryClientProvider client={client}>{node}</QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

describe('escalation note reaches the pixels', () => {
  const cooldown = {
    category: 'sandbox-provider' as const,
    message: 'The runtime did not start. Retrying automatically.',
    retryable: true,
    evidence: {
      check: 'start_timeout',
      observed_at: '2026-09-26T10:21:34.520Z',
      error: null,
      attempts: 1,
      next_retry_at: '2099-09-26T10:23:34.520Z',
    },
  };

  test('the loader shows a waiting state and the next automatic attempt', () => {
    const html = render(
      <SessionStartingLoader
        stage="starting"
        delayMs={0}
        note={NOTE}
        reason="runtime_wake_cooldown"
        failure={cooldown}
      />,
    );
    expect(html).toContain('Still starting your computer');
    expect(html).toContain('Trying again automatically');
    expect(html).toContain('attempt 2');
    expect(html).not.toContain('did not start');
    expect(html).not.toContain(NOTE);
  });

  test('the conversation banner shows the same waiting state', () => {
    const html = render(
      <SessionConnectingBanner
        stage="starting"
        note={NOTE}
        reason="runtime_wake_cooldown"
        failure={cooldown}
      />,
    );
    expect(html).toContain('Still starting your computer');
    expect(html).toContain('attempt 2');
    expect(html).not.toContain(NOTE);
  });

  test('the connecting banner shows the ladder note instead of the phase label', () => {
    const html = render(<SessionConnectingBanner stage="starting" note={NOTE} />);
    expect(html).toContain(NOTE);
    expect(html).not.toContain('Waking the agent');
  });

  test('without a note the banner keeps the ordinary phase label', () => {
    const html = render(<SessionConnectingBanner stage="starting" />);
    expect(html).toContain('Loading your workspace');
    expect(html).not.toContain('Still waking');
  });

  test('the loader shows the ladder note instead of the phase label', () => {
    const html = render(<SessionStartingLoader stage="starting" delayMs={0} note={NOTE} />);
    expect(html).toContain(NOTE);
  });

  test('the legacy variant input renders the same ladder note', () => {
    const html = render(
      <SessionStartingLoader stage="starting" delayMs={0} variant="stepper" note={NOTE} />,
    );
    expect(html).toContain(NOTE);
    expect(html).not.toContain('This usually takes a few seconds.');
  });
});

describe('session starting loader treatment', () => {
  test('the retry clock reaches now and stale failure data does not override a live wake', () => {
    const failure = {
      category: 'sandbox-provider' as const,
      message: 'The runtime did not start.',
      retryable: true,
      evidence: {
        check: 'start_timeout',
        observed_at: null,
        error: null,
        attempts: 1,
        next_retry_at: '2026-09-26T10:23:34.520Z',
      },
    };
    expect(
      sessionWakeStatusNote({
        reason: 'runtime_wake_cooldown',
        failure,
        now: Date.parse('2026-09-26T10:21:34.520Z'),
      }),
    ).toBe('Still starting your computer. Trying again in 2m 0s (attempt 2).');
    expect(
      sessionWakeStatusNote({
        reason: 'runtime_wake_cooldown',
        failure,
        now: Date.parse('2026-09-26T10:23:34.520Z'),
      }),
    ).toBe('Still starting your computer. Trying again now (attempt 2).');
    expect(sessionWakeStatusNote({ reason: 'runtime_waking', failure, note: NOTE, now: 0 })).toBe(
      NOTE,
    );
  });

  test('a retry clock that is unknown or out of range shows no countdown', () => {
    // The server's cooldown is 2, 5 or 10 minutes. A clock hours or decades
    // away (a skewed client clock, an epoch-0 `now`, a malformed stamp) is not
    // a wait to count down: it rendered as tens of millions of minutes.
    const failure = (next_retry_at: string | null) => ({
      category: 'sandbox-provider' as const,
      message: 'The runtime did not start.',
      retryable: true,
      evidence: { check: 'start_timeout', observed_at: null, error: null, attempts: 1, next_retry_at },
    });
    const now = Date.parse('2026-10-05T00:18:00.000Z');
    const plain = 'Still starting your computer. Trying again automatically (attempt 2).';
    for (const [retryAt, at] of [
      ['2026-10-05T00:20:00.000Z', 0],
      ['2125-10-05T00:18:00.000Z', now],
      ['2026-10-05T01:18:01.000Z', now],
      ['not a date', now],
      [null, now],
      ['2026-10-05T00:20:00.000Z', Number.NaN],
    ] as const) {
      expect(
        sessionWakeStatusNote({ reason: 'runtime_wake_cooldown', failure: failure(retryAt), now: at }),
      ).toBe(plain);
    }
    expect(
      sessionWakeStatusNote({
        reason: 'runtime_wake_cooldown',
        failure: failure('2026-10-05T00:28:00.000Z'),
        now,
      }),
    ).toBe('Still starting your computer. Trying again in 10m 0s (attempt 2).');
  });

  test('renders quiet progress without prototype or legacy motion', () => {
    const html = render(<SessionStartingLoader stage="starting" delayMs={0} variant="stepper" />);

    expect(html).toContain('Starting your session');
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuetext="Step 2 of 4: Loading your workspace"');
    expect(html).not.toContain('data-uidotsh-pick');
    expect(html).not.toContain('animate-pulse');
    expect(html).not.toContain('This usually takes a few seconds.');
  });
});

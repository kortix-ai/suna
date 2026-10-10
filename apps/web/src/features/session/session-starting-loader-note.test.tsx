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

  test('the loader shows the failed wake and next automatic attempt', () => {
    const html = render(
      <SessionStartingLoader
        stage="starting"
        delayMs={0}
        note={NOTE}
        reason="runtime_wake_cooldown"
        failure={cooldown}
      />,
    );
    expect(html).toContain('Computer did not start');
    expect(html).toContain('Retrying automatically');
    expect(html).toContain('attempt 2');
    expect(html).not.toContain(NOTE);
  });

  test('the conversation banner shows the same failed wake', () => {
    const html = render(
      <SessionConnectingBanner
        stage="starting"
        note={NOTE}
        reason="runtime_wake_cooldown"
        failure={cooldown}
      />,
    );
    expect(html).toContain('Computer did not start');
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
    ).toBe('Computer did not start. Retrying automatically in 2m 0s (attempt 2).');
    expect(
      sessionWakeStatusNote({
        reason: 'runtime_wake_cooldown',
        failure,
        now: Date.parse('2026-09-26T10:23:34.520Z'),
      }),
    ).toBe('Computer did not start. Retrying automatically now (attempt 2).');
    expect(sessionWakeStatusNote({ reason: 'runtime_waking', failure, note: NOTE, now: 0 })).toBe(
      NOTE,
    );
  });

  test('a wait the server cannot owe renders no duration at all', () => {
    // The API's wake backoff caps at 10 minutes (RUNTIME_START_RETRY_BACKOFF_MS:
    // 120s, 300s, 600s). A next_retry_at further out than that is a broken or
    // future-skewed stamp, not a schedule — rendering it told a user to wait
    // ~99 years for a restore that was healthy (KRTX-1634). The note must name
    // the retry and stay silent about when.
    const farFuture = {
      category: 'sandbox-provider' as const,
      message: 'The runtime did not start. Retrying automatically.',
      retryable: true,
      evidence: {
        check: 'start_timeout',
        observed_at: '2026-09-26T10:21:34.520Z',
        error: null,
        attempts: 1,
        next_retry_at: '2125-10-05T00:18:00.000Z', // ~99 years out
      },
    };
    expect(
      sessionWakeStatusNote({
        reason: 'runtime_wake_cooldown',
        failure: farFuture,
        now: Date.parse('2026-10-05T00:18:00.000Z'),
      }),
    ).toBe('Computer did not start. Retrying automatically (attempt 2).');
    const decadesOut = {
      category: 'sandbox-provider' as const,
      message: 'The runtime did not start. Retrying automatically.',
      retryable: true,
      evidence: {
        check: 'start_timeout',
        observed_at: '2026-09-26T10:21:34.520Z',
        error: null,
        attempts: 1,
        // The repo's own test fixture next_retry_at: a stamp 73 years out.
        next_retry_at: '2099-09-26T10:23:34.520Z',
      },
    };
    expect(
      sessionWakeStatusNote({
        reason: 'runtime_wake_cooldown',
        failure: decadesOut,
        now: Date.parse('2026-10-05T00:18:00.000Z'),
      }),
    ).toBe('Computer did not start. Retrying automatically (attempt 2).');
  });

  test('a wait inside the server backoff keeps its duration', () => {
    const failure = {
      category: 'sandbox-provider' as const,
      message: 'The runtime did not start.',
      retryable: true,
      evidence: {
        check: 'start_timeout',
        observed_at: null,
        error: null,
        attempts: 1,
        next_retry_at: '2026-09-26T10:23:04.520Z',
      },
    };
    expect(
      sessionWakeStatusNote({
        reason: 'runtime_wake_cooldown',
        failure,
        now: Date.parse('2026-09-26T10:21:34.520Z'),
      }),
    ).toBe('Computer did not start. Retrying automatically in 1m 30s (attempt 2).');
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

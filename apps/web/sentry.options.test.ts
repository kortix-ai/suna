import { expect, test } from 'bun:test';
import * as Sentry from '@sentry/nextjs';

// SENTRY_DSN is read once, at module load, so set it before importing anything
// that reads it — the same order the Next.js runtime loads these modules in.
process.env.NEXT_PUBLIC_SENTRY_DSN = 'https://public@example.test/1';
const { sentryOptions } = await import('./sentry.options');

// The three runtime configs (client/server/edge) share one options builder.
// Before this builder existed the edge config had lost `sendDefaultPii: false`,
// so these tests pin that every runtime keeps PII off and runs the noise filter.

test('sentryOptions keeps PII off, sets dsn/environment, and passes through the runtime extras', () => {
  const ignoreErrors = [/^Non-Error promise rejection captured/];
  const denyUrls = [/^https:\/\/www\.googletagmanager\.com\//];
  const options = sentryOptions({ tracesSampleRate: 0.1, ignoreErrors, denyUrls });

  expect(options?.sendDefaultPii).toBe(false);
  expect(options?.dsn).toBe('https://public@example.test/1');
  expect(options?.environment).toBeTruthy();
  expect(options?.tracesSampleRate).toBe(0.1);
  expect(options?.ignoreErrors).toBe(ignoreErrors);
  expect(options?.denyUrls).toBe(denyUrls);
});

test('the shared beforeSend drops injected browser noise but keeps real errors', () => {
  const { beforeSend } = sentryOptions({ tracesSampleRate: 0.1 });
  const noise = {
    exception: {
      values: [
        {
          type: 'Error',
          value: 'Talisman extension has not been configured yet. Please continue with onboarding.',
          stacktrace: { frames: [{ filename: 'app:///page.js', function: 'ne.handleResponse' }] },
        },
      ],
    },
  } as Sentry.ErrorEvent;
  const real = { exception: { values: [{ type: 'Error', value: 'Synthetic application failure' }] } } as Sentry.ErrorEvent;

  expect(beforeSend?.(noise, {})).toBeNull();
  expect(beforeSend?.(real, {})).toBe(real);
});

test.each(['./sentry.client.config', './sentry.server.config', './sentry.edge.config'])(
  'runtime config %s initializes Sentry with sendDefaultPii: false',
  async (configPath) => {
    await import(configPath);
    const options = Sentry.getClient()?.getOptions();
    expect(options?.sendDefaultPii).toBe(false);
    await Sentry.close();
    // init() started a release-health session on the isolation scope; drop it
    // so it does not leak into the next config's client (see sentry.client.config.test.ts).
    Sentry.getIsolationScope().setSession();
  },
);

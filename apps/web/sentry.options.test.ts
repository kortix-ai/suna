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

// Each runtime config runs in its own bun process: @sentry/nextjs keeps the
// first client, so a second init() in one process would leave getClient()
// pointing at the previous config's options and hide a regression. The
// tracesSampleRate and the client-only filters prove each read is that
// config's own client.
const runtimeConfigs = [
  { config: './sentry.client.config.ts', tracesSampleRate: 0.1, clientFilters: true },
  { config: './sentry.server.config.ts', tracesSampleRate: 0.2, clientFilters: false },
  { config: './sentry.edge.config.ts', tracesSampleRate: 0.1, clientFilters: false },
];

test.each(runtimeConfigs)(
  'runtime config $config initializes its own Sentry client with sendDefaultPii: false',
  ({ config, tracesSampleRate, clientFilters }) => {
    const probe = `
      const Sentry = await import('@sentry/nextjs');
      await import(${JSON.stringify(config)});
      const options = Sentry.getClient()?.getOptions();
      console.log(JSON.stringify({
        tracesSampleRate: options?.tracesSampleRate,
        sendDefaultPii: options?.sendDefaultPii ?? null,
        clientFilters: Boolean(options?.ignoreErrors?.length && options?.denyUrls?.length),
      }));
    `;
    const run = Bun.spawnSync([process.execPath, '-e', probe], {
      cwd: import.meta.dir,
      env: { ...process.env, NEXT_PUBLIC_SENTRY_DSN: 'https://public@example.test/1' },
    });
    expect(run.exitCode).toBe(0);
    const lines = run.stdout.toString().trim().split('\n');
    expect(JSON.parse(lines[lines.length - 1])).toEqual({
      tracesSampleRate,
      sendDefaultPii: false,
      clientFilters,
    });
  },
);

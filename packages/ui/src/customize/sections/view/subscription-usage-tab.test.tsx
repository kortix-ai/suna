import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AccountSecretResource, SubscriptionUsage } from '@kortix/sdk';
import { SubscriptionUsageCard } from './subscription-usage-tab';

const secret = {
  provider_id: 'codex',
  label: 'Synthetic subscription',
  active: true,
} as AccountSecretResource;
const usage: SubscriptionUsage = {
  limited: true,
  source: 'usage_endpoint',
  observed_at: new Date().toISOString(),
  windows: [
    {
      id: 'weekly',
      window_minutes: 10080,
      used_percent: 100,
      resets_at: '2020-01-01T00:00:00Z',
    },
  ],
};
const render = (value: AccountSecretResource, data: SubscriptionUsage | null) =>
  renderToStaticMarkup(
    <SubscriptionUsageCard
      secret={value}
      usage={data}
      fetching={false}
      error={false}
      onRefresh={() => {}}
      onConnect={() => {}}
    />,
  );
test('an expired cached limit does not claim a current limit', () => {
  const html = render(secret, usage);
  expect(html).not.toContain('Limit reached');
  expect(html).toContain('Reset time passed');
});
test('a refused login has a reconnect action', () => {
  const html = render(
    { ...secret, needs_reauth_at: '2026-01-01T00:00:00Z' },
    usage,
  );
  expect(html).toContain('Reconnect needed');
  expect(html).toContain('>Reconnect<');
});
test('unknown usage never displays a zero usage meter', () => {
  const html = render(secret, null);
  expect(html).toContain('No usage reported yet');
  expect(html).not.toContain('role="progressbar"');
});

test('an expired full window plus a future partial window does not claim a current limit', () => {
  const html = render(secret, {
    ...usage,
    windows: [
      ...usage.windows,
      {
        id: 'five_hour',
        used_percent: 20,
        window_minutes: 300,
        resets_at: '2099-01-01T00:00:00Z',
      },
    ],
  });
  expect(html).not.toContain('Limit reached');
});

test('a weekly-only subscription says five-hour usage is unreported, without inventing a meter', () => {
  const html = render(secret, {
    ...usage,
    windows: [
      {
        id: 'weekly',
        window_minutes: 10080,
        used_percent: 20,
        resets_at: null,
      },
    ],
  });
  expect(html).toContain('Five-hour window not reported');
  expect((html.match(/role="progressbar"/g) ?? []).length).toBe(1);
});
test('Fable has a separate weekly meter and explains the shared weekly allowance', () => {
  const html = render(
    { ...secret, provider_id: 'claude-agent' },
    {
      ...usage,
      windows: [
        {
          id: 'seven_day_fable',
          window_minutes: null,
          used_percent: 64,
          resets_at: null,
        },
      ],
    },
  );
  expect(html).toContain('Weekly · Fable');
  expect(html).toContain('64%');
  expect(html).toContain('Fable usage also counts');
});

test('a provider rejection below 100 percent marks a current limit as reached', () => {
  const html = render(secret, {
    ...usage,
    limited: true,
    windows: [
      {
        id: 'five_hour',
        window_minutes: 300,
        used_percent: 95,
        resets_at: '2099-01-01T00:00:00Z',
      },
    ],
  });
  expect(html).toContain('Limit reached');
  expect(html).not.toContain('Usage reported');
});

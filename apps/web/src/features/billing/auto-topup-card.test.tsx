import { describe, expect, test } from 'bun:test';
import type { AutoTopupSettings } from '@kortix/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';

import en from '../../../translations/en.json';
import { AutoTopupCard, clampAutoTopupValues, minimumAutoTopupAmount } from './auto-topup-card';

function render(settings: AutoTopupSettings): string {
  const client = new QueryClient();
  client.setQueryData(['auto-topup-settings', { accountId: null }], settings);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="en" messages={en} onError={() => {}}>
        <AutoTopupCard fetchSettings />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

const settings = {
  enabled: true,
  threshold: 5,
  amount: 20,
  disabled_reason: null,
  last_failure_reason: null,
  last_failure_at: null,
} as AutoTopupSettings;

describe('auto top-up threshold in credits', () => {
  test('the threshold field takes credits and the server receives USD (credits ÷ 100)', () => {
    expect(clampAutoTopupValues('550', '20')).toEqual({ threshold: 5.5, amount: 20 });
    expect(clampAutoTopupValues('2500', '50')).toEqual({ threshold: 25, amount: 50 });
  });

  test('below the 100-credit minimum the threshold clamps to $1', () => {
    expect(clampAutoTopupValues('40', '20').threshold).toBe(1);
    expect(clampAutoTopupValues('', '20').threshold).toBe(1);
  });

  test('the top-up amount stays in dollars', () => {
    expect(clampAutoTopupValues('500', '25').amount).toBe(25);
  });

  test('the minimum top-up is the next whole dollar a buffer above the threshold', () => {
    expect(minimumAutoTopupAmount(5)).toBe(6);
    expect(minimumAutoTopupAmount(5.5)).toBe(7);
  });

  // A server render runs no effect, so the fields show the defaults: the $1
  // default threshold as 100 credits, the $5 default amount as dollars.
  test('the threshold field reads in credits with its unit after it; the amount keeps its $', () => {
    const html = render(settings);
    expect(html).toMatch(/min="100"[^>]*aria-label="Top-up threshold in credits"[^>]*value="100"/);
    expect(html).toMatch(/>\$<\/span><input[^>]*aria-label="Top-up amount in dollars"[^>]*value="5"/);
    expect(html).toContain('<span class="text-muted-foreground">credits</span>');
  });
});

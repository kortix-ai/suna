import { describe, expect, test } from 'bun:test';
import type { AutoTopupSettings } from '@kortix/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';

import { AutoTopupCard } from './auto-topup-card';

const AT = '2026-10-08T03:00:00.000Z';

/** The Billing pane's card, rendered on the server with these fetched settings. */
function render(settings: AutoTopupSettings): string {
  const client = new QueryClient();
  // A server render has no billing account in context: the card reads its
  // settings under a null account id.
  client.setQueryData(['auto-topup-settings', { accountId: null }], settings);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
        <AutoTopupCard fetchSettings />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

const base = { enabled: true, threshold: 5, amount: 20, disabled_reason: null, last_failure_reason: null, last_failure_at: null };

// KRTX-1718: a declined card turned auto top-up off, and the pane showed only "off".
describe('the auto top-up card after a failed charge', () => {
  test('turned off by a declined card: says so, with the reason', () => {
    const markup = render({
      ...base,
      enabled: false,
      disabled_reason: 'insufficient_funds',
      last_failure_reason: 'insufficient_funds',
      last_failure_at: AT,
    });
    expect(markup).toContain('Auto top-up turned off on');
    expect(markup).toContain('the last charge failed (insufficient_funds)');
    expect(markup).toContain('Update the payment method, then turn auto top-up back on.');
  });

  test('still on after a soft failure: says it retries', () => {
    const markup = render({ ...base, last_failure_reason: 'processing_error', last_failure_at: AT });
    expect(markup).toContain('The last auto top-up charge failed on');
    expect(markup).toContain('(processing_error)');
  });

  test('no failed charge: no notice', () => {
    const markup = render(base);
    expect(markup).not.toContain('turned off on');
    expect(markup).not.toContain('charge failed');
  });
});

import { expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';
import { CreditExpiry } from './credit-expiry';

function render(expiresAt?: string | null) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={{}}>
      <CreditExpiry expiresAt={expiresAt} />
    </NextIntlClientProvider>,
  );
}

test('shows the scheduled date and preserves its exact timestamp', () => {
  expect(render('2026-11-24T12:00:00Z')).toContain('Nov 24, 2026');
  expect(render('2026-11-24T12:00:00Z')).toContain('dateTime="2026-11-24T12:00:00Z"');
});

test('does not invent an expiry for missing or malformed legacy data', () => {
  for (const date of [undefined, null, '', 'invalid']) expect(render(date)).toBe('');
});

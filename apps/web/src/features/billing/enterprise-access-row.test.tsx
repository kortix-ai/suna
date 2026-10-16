import { describe, expect, test } from 'bun:test';
import type { AccountState } from '@kortix/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';

import { EnterpriseAccessRow } from './enterprise-access-row';

function render(patch: Partial<AccountState>, accountId: string | undefined = 'acc_1'): string {
  const state = { can_manage_billing: true, ...patch } as AccountState;
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
        <EnterpriseAccessRow state={state} accountId={accountId} />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

const ends = '2027-03-01T00:00:00.000Z';
const contract = { id: 'c', license_usd: 25000, term_months: 12, collection: 'invoice' as const, starts_at: null, ends_at: ends, renews: true };

// Enterprise has three states and no clock (plans-and-access.md, "Enterprise").
describe('EnterpriseAccessRow', () => {
  test('off: badge Off, a billing manager can turn on the demo and talk to sales', () => {
    const markup = render({ enterprise: { state: 'off' } });
    expect(markup).toContain('Enterprise features');
    expect(markup).toContain('>Off<');
    expect(markup).toContain('Turn on demo');
    expect(markup).toContain('Talk to sales');
  });

  test('off for a member: no demo switch, Talk to sales stays', () => {
    const markup = render({ enterprise: { state: 'off' }, can_manage_billing: false });
    expect(markup).not.toContain('Turn on demo');
    expect(markup).toContain('Talk to sales');
  });

  test('an older API without the enterprise block reads as off', () => {
    expect(render({})).toContain('>Off<');
  });

  test('demo: badge Demo, says so, and a manager can turn it off', () => {
    const markup = render({ enterprise: { state: 'demo' } });
    expect(markup).toContain('>Demo<');
    expect(markup).toContain('On as a demo. Talk to sales for a license.');
    expect(markup).toContain('Turn off demo');
    expect(markup).toContain('Talk to sales');
  });

  test('licensed: badge On, the renewal date, no demo switch and no sales button', () => {
    const markup = render({ enterprise: { state: 'licensed' }, contract });
    expect(markup).toContain('>On<');
    expect(markup).toContain('Licensed · renews March 1, 2027');
    expect(markup).not.toContain('demo');
    expect(markup).not.toContain('Talk to sales');
  });

  test('a license that does not renew says until when', () => {
    const markup = render({ enterprise: { state: 'licensed' }, contract: { ...contract, renews: false } });
    expect(markup).toContain('Licensed until March 1, 2027');
  });
});

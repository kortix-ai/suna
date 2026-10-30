import { describe, expect, mock, test } from 'bun:test';
import type { AccountState } from '@kortix/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';

// A server render has no signed-in user and no billing config: stub the two
// lookups the notice makes, and render with billing on.
mock.module('@/features/providers/auth-provider', () => ({ useAuth: () => ({ user: null }) }));
mock.module('@/lib/config', () => ({ isBillingEnabled: () => true }));

const { PlanAccessNotice } = await import('./plan-access-notice');

function render(patch: Partial<AccountState>): string {
  const state = { can_manage_billing: true, ...patch } as AccountState;
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
        <PlanAccessNotice state={state} />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

const offer = { id: 'c', license_usd: 25000, term_months: 12, collection: 'checkout' as const };

// "kill that TRIAL bullshit in its entirety" (2026-10-15): the notice carries a
// license offer and the grace after a license ended, nothing else.
describe('the plan access notice', () => {
  test('a leftover trial block renders nothing', () => {
    const trial = { plan: 'enterprise' as const, started_at: null, ends_at: '2026-11-14T00:00:00.000Z', days_left: 9 };
    const markup = render({ trial });
    expect(markup).toBe('<div class="space-y-3 empty:hidden"></div>');
    expect(markup.toLowerCase()).not.toContain('trial');
  });

  test('an open card offer shows the license and term, no credits, and Accept for a billing manager', () => {
    const markup = render({ enterprise_offer: offer });
    expect(markup).toContain('Enterprise offer');
    expect(markup).toContain('$25,000 license for 12 months.');
    expect(markup).not.toContain('credits');
    expect(markup).toContain('Accept and pay');
  });

  test('a member sees the offer and who accepts it', () => {
    const markup = render({ enterprise_offer: offer, can_manage_billing: false });
    expect(markup).not.toContain('Accept and pay');
    expect(markup).toContain('An account owner or admin accepts the offer.');
  });

  test('an invoiced offer has no Accept button', () => {
    const markup = render({ enterprise_offer: { ...offer, collection: 'invoice' } });
    expect(markup).toContain('This offer is invoiced');
    expect(markup).not.toContain('Accept and pay');
  });

  test('the grace after a license says until when SSO stays on, with Talk to sales', () => {
    const markup = render({ grace: { reason: 'contract_ended', ends_at: '2026-11-28T00:00:00.000Z' } });
    expect(markup).toContain('Enterprise access ended');
    expect(markup).toContain('SSO and SCIM stay on until November 28, 2026');
    expect(markup).toContain('Talk to sales');
    expect(markup).not.toContain('>Upgrade<');
  });

  test('wallet admission does not advertise managed inference on Free', () => {
    const markup = render({ model_access: { managed: false, requires_provider_key: true } });
    expect(markup).toContain('Kortix Managed Models');
    expect(markup).toContain('or connect your own provider.');
  });

  test('managed access does not show the provider requirement', () => {
    expect(render({ model_access: { managed: true, requires_provider_key: false } })).not.toContain('Kortix Managed Models');
  });

  test('an account with neither renders nothing', () => {
    expect(render({})).toBe('<div class="space-y-3 empty:hidden"></div>');
  });
});

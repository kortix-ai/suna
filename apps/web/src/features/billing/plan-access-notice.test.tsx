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

const trial = { plan: 'enterprise' as const, started_at: null, ends_at: '2026-11-14T00:00:00.000Z', days_left: 9 };

// "if ON A TRIAL CLEARLY STATE THAT THE ACCOUNT IS ON A TRIAL & GIVE EM OPTION
// TO UPGRADE AT ANY TIME" (2026-10-15), then "ignore the UPGRADE NOW on
// ENTERPRISE" (same day): Enterprise is sold by sales, a Credits trial upgrades.
describe('the plan access notice', () => {
  test('an Enterprise trial says so, with the days left, the end date and Talk to sales, no Upgrade', () => {
    const markup = render({ trial });
    expect(markup).toContain('Enterprise trial · 9 days left');
    expect(markup).toContain('November 14, 2026');
    expect(markup).toContain('To keep Enterprise, talk to sales.');
    expect(markup).toContain('Talk to sales');
    expect(markup).not.toContain('>Upgrade<');
  });

  test('a member on an Enterprise trial is not told to ask for an upgrade', () => {
    const markup = render({ trial, can_manage_billing: false });
    expect(markup).toContain('Enterprise trial · 9 days left');
    expect(markup).not.toContain('Ask an account owner or admin to upgrade.');
  });

  test('a Credits trial offers Upgrade to a billing manager, and who to ask to a member', () => {
    const credits = { ...trial, plan: 'credits' as const };
    expect(render({ trial: credits })).toContain('>Upgrade<');
    const member = render({ trial: credits, can_manage_billing: false });
    expect(member).toContain('Ask an account owner or admin to upgrade.');
    expect(member).not.toContain('>Upgrade<');
  });

  test('an open card offer shows its terms and Accept for a billing manager', () => {
    const markup = render({
      enterprise_offer: { id: 'c', license_usd: 25000, credits_usd: 15000, term_months: 12, collection: 'checkout' },
    });
    expect(markup).toContain('Enterprise offer');
    expect(markup).toContain('$25,000 license and $15,000 in credits per year, for 12 months.');
    expect(markup).toContain('Accept and pay');
  });

  test('an invoiced offer has no Accept button', () => {
    const markup = render({
      enterprise_offer: { id: 'c', license_usd: 25000, credits_usd: 15000, term_months: 12, collection: 'invoice' },
    });
    expect(markup).toContain('This offer is invoiced');
    expect(markup).not.toContain('Accept and pay');
  });

  test('the grace after a trial says until when SSO stays on', () => {
    const markup = render({ grace: { reason: 'trial_ended', ends_at: '2026-11-28T00:00:00.000Z' } });
    expect(markup).toContain('Enterprise access ended');
    expect(markup).toContain('SSO and SCIM stay on until November 28, 2026');
  });

  test('an account with none of the three renders nothing', () => {
    expect(render({})).toBe('<div class="space-y-3 empty:hidden"></div>');
  });
});

import { describe, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';

import { accountStateKeys } from '@kortix/ui/internal/billing/index';
import { TurnErrorDisplay } from '@kortix/ui/session';

/** The out-of-credits card for a viewer whose account state says
 *  `can_manage_billing`, or whose account state has not loaded (`undefined`). */
function render(
  canManageBilling: boolean | undefined,
  errorText = 'insufficient credits: Balance: $0.00',
): string {
  const client = new QueryClient();
  // A server render reads the account store's initial state: no selected
  // account, so the card asks for the account state under a null id.
  if (canManageBilling !== undefined) {
    client.setQueryData(accountStateKeys.state(null), { can_manage_billing: canManageBilling });
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
        <TurnErrorDisplay errorText={errorText} />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

// KRTX-1720: a member at $0 was offered Buy credits and auto top-up. The API
// answers a member 403, and the billing pane the links open is hidden from them.
describe('the out-of-credits card', () => {
  test('a member is told who can add credits, with no buy or auto top-up link', () => {
    const markup = render(false);
    expect(markup).toContain('Only an account owner or admin can add credits');
    expect(markup).not.toContain('Buy credits');
    expect(markup).not.toContain('Enable auto top-up');
  });

  test('while the account state loads, the card offers no purchase link and asks no owner', () => {
    const markup = render(undefined);
    expect(markup).toContain('You ran out of credits');
    expect(markup).not.toContain('Buy credits');
    expect(markup).not.toContain('Enable auto top-up');
    expect(markup).not.toContain('Only an account owner or admin can add credits');
  });

  test('a billing manager keeps both links', () => {
    const markup = render(true);
    expect(markup).toContain('Buy credits');
    expect(markup).toContain('Enable auto top-up');
    expect(markup).not.toContain('Only an account owner or admin can add credits');
  });
});

// The balance is what the account holds, so it reads in credits (1 credit =
// $0.01). The API's message changed from dollars to credits; the card reads both.
describe('the out-of-credits balance', () => {
  test('the credits message reads its balance in credits', () => {
    const markup = render(true, 'Insufficient credits. Balance: 1,250 credits, required: 3 credits');
    expect(markup).toContain('Balance 1,250 credits');
  });

  test('an older server\'s dollar message reads in credits too', () => {
    const markup = render(true, 'Payment Required: Insufficient credits. Balance: $-0.06');
    expect(markup).toContain('Balance -6 credits');
    expect(markup).not.toContain('$');
  });

  test('a message without a balance shows the server text', () => {
    const markup = render(true, 'Payment Required: out of credits');
    expect(markup).toContain('Payment Required: out of credits');
  });
});

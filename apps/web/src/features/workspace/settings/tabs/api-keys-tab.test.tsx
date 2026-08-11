import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { ApiKeysTabView } from './api-keys-tab';

/**
 * `ApiKeysTabView` is the pure, props-only half — see this tab's header
 * comment. Unlike `audit-tab.tsx`/`identity-tab.tsx`, there is no
 * entitlement axis to pin here (the source page's `tokens` branch has no
 * loading/upsell state of its own — see the header comment's "no
 * entitlement content-gate" note), so these tests only pin slot presence,
 * order, and the one genuinely new element: the auth snippet.
 */
describe('ApiKeysTabView', () => {
  test('renders the header title and description', () => {
    const out = renderToStaticMarkup(<ApiKeysTabView />);
    expect(out).toContain('API keys');
    expect(out).toContain('Tokens that let scripts and CI act as this organization.');
  });

  test('renders the PAT policy slot', () => {
    const out = renderToStaticMarkup(
      <ApiKeysTabView patPolicySlot={<div>pat-policy-content</div>} />,
    );
    expect(out).toContain('pat-policy-content');
  });

  test('renders the service accounts slot', () => {
    const out = renderToStaticMarkup(
      <ApiKeysTabView serviceAccountsSlot={<div>service-accounts-content</div>} />,
    );
    expect(out).toContain('service-accounts-content');
  });

  test('the PAT policy slot renders before the service accounts slot — matches page.tsx:591-592', () => {
    const out = renderToStaticMarkup(
      <ApiKeysTabView
        patPolicySlot={<div>pat-policy-marker</div>}
        serviceAccountsSlot={<div>service-accounts-marker</div>}
      />,
    );
    expect(out.indexOf('pat-policy-marker')).toBeLessThan(out.indexOf('service-accounts-marker'));
  });

  test('with no slots supplied, the header still renders (each real card does its own loading state)', () => {
    const out = renderToStaticMarkup(<ApiKeysTabView />);
    expect(out).toContain('API keys');
  });

  test('renders the auth snippet with a copyable bearer-token example', () => {
    const out = renderToStaticMarkup(<ApiKeysTabView />);
    expect(out).toContain('Using a key');
    expect(out).toContain('Authorization: Bearer');
    expect(out).toContain('aria-label="Copy code"');
  });

  test('the auth snippet renders after both card slots', () => {
    const out = renderToStaticMarkup(
      <ApiKeysTabView
        patPolicySlot={<div>pat-policy-marker</div>}
        serviceAccountsSlot={<div>service-accounts-marker</div>}
      />,
    );
    expect(out.indexOf('service-accounts-marker')).toBeLessThan(out.indexOf('Using a key'));
  });

  test('does not render a second table — no thead/table markup of its own beyond what a slot supplies', () => {
    const out = renderToStaticMarkup(<ApiKeysTabView />);
    expect(out).not.toContain('<table');
    expect(out).not.toContain('<thead');
  });
});

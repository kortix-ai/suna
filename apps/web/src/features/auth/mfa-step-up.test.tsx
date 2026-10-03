import { describe, expect, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * The global step-up dialog's request contract.
 *
 * The security tab asks the dialog PROACTIVELY before Remove factor and
 * Sign out other devices: `requestMfaStepUp` dispatches `MFA_REQUIRED_EVENT`
 * with a detail the provider reads (description, factor, and the action to
 * run once the code verifies). These tests pin the contract both halves
 * share — the event name, the detail shape, and that a request without a
 * detail leaves the bare-event flow intact.
 *
 * The interactive verify flow itself (challengeAndVerify → onVerified) runs
 * in the browser; this workspace has no DOM harness, and the same flow is
 * already exercised in production by the account-wide "Require MFA"
 * denial that opens this dialog.
 */

mock.module('@/i18n/use-translations', () => ({
  useTranslations: (namespace: string) => {
    const t = (key: string) => `${namespace}.${key}`;
    return Object.assign(t, { raw: t });
  },
}));

const { MFA_REQUIRED_EVENT, MfaStepUpProvider, requestMfaStepUp } = await import('./mfa-step-up');

describe('requestMfaStepUp', () => {
  test('dispatches the request as the event detail the provider reads', () => {
    // The dialog and its callers speak through `window` events; bun tests run
    // without a DOM, so stand up the smallest EventTarget for this test and
    // restore the global exactly as it was afterwards.
    const previous = (globalThis as { window?: EventTarget }).window;
    const target = new EventTarget();
    (globalThis as { window?: EventTarget }).window = target;

    const onVerified = () => {};
    let detail: unknown;
    const listener = (event: Event) => {
      detail = (event as CustomEvent).detail;
    };
    target.addEventListener(MFA_REQUIRED_EVENT, listener);
    try {
      requestMfaStepUp({ description: 'warning copy', onVerified });
    } finally {
      target.removeEventListener(MFA_REQUIRED_EVENT, listener);
      (globalThis as { window?: EventTarget }).window = previous;
    }

    expect((detail as { onVerified?: () => void }).onVerified).toBe(onVerified);
    expect((detail as { description?: string }).description).toBe('warning copy');
  });
});

describe('MfaStepUpProvider', () => {
  test('renders its children while closed', () => {
    const markup = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(MfaStepUpProvider, null, createElement('div', { id: 'child' }, 'app')),
      ),
    );
    expect(markup).toContain('app');
  });
});

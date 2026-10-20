import { afterEach, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { NextIntlClientProvider } from 'next-intl';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import en from '../../../translations/en.json';
import sr from '../../../translations/sr.json';

const window = new Window();
Object.assign(globalThis, {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  ResizeObserver: window.ResizeObserver,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const successToast = mock(() => undefined);
mock.module('@/components/ui/toast', () => ({ successToast, errorToast: mock() }));
mock.module('next/navigation', () => ({ useParams: () => ({ id: 'project-test', sessionId: 'session-test' }) }));
const sdk = await import('@kortix/sdk/react');
mock.module('@kortix/sdk/react', () => ({ ...sdk, useProjectSession: () => ({ data: undefined }) }));
mock.module('@/hooks/channels/use-channel-bindings', () => ({ useChannelBindings: () => ({ data: undefined }) }));
const audit = await import('./session-audit-shared');
mock.module('./session-audit-shared', () => ({
  ...audit,
  useSessionAudit: () => ({ data: { actions: [{
    execution_id: 'execution-test', action: 'test.read', status: 'pending_approval',
    risk: 'read', at: '2026-10-01T00:00:00Z', can_resolve: true,
    result_summary: { args_preview: { value: 'synthetic' }, args_preview_complete: true },
  }] } }),
  useResolveApproval: () => ({ mutate: (_input: unknown, callbacks: { onSuccess: () => void; onSettled: () => void }) => {
    callbacks.onSuccess();
    callbacks.onSettled();
  } }),
}));
const { SessionApprovalPrompt } = await import('./session-approval-prompt');
afterEach(() => successToast.mockClear());

for (const [locale, messages] of [['en', en], ['sr', sr]] as const) {
  for (const decision of ['approve', 'deny'] as const) {
    test(`${locale}: ${decision} reports the recorded decision in the toast`, async () => {
      const container = document.createElement('div');
      document.body.append(container);
      const root = createRoot(container);
      try {
        await act(async () => {
          root.render(<NextIntlClientProvider locale={locale} messages={messages} timeZone="UTC">
            <SessionApprovalPrompt />
          </NextIntlClientProvider>);
        });
        const copy = messages.hardcodedUi.i18nComplete;
        const label = decision === 'approve' ? copy.texta1982c442ca3 : copy.text05a2d7332eb9;
        const buttons = Array.from(container.querySelectorAll('button'));
        const button = buttons.find((candidate) => candidate.textContent?.includes(label));
        expect(button).toBeDefined();
        await act(async () => button?.click());
        expect(successToast).toHaveBeenCalledWith(decision === 'approve' ? copy.text0674d4a026cb : copy.text4341be8eb7f0);
      } finally {
        await act(async () => root.unmount());
        container.remove();
      }
    });
  }
}

import { IntlTestProvider } from '../../test-utils/intl';
import { TestUiHost } from '../../test-utils/ui-host';
import { qk, useFeatureFlag } from '@kortix/sdk/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

const win = new Window();
Object.assign(globalThis, { window: win, document: win.document, navigator: win.navigator });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
let allowed = true;
let loading = false;
let failed = false;
const update = mock(async () => {
  if (failed) throw new Error('Could not enable reminders');
  return { project_id: 'test-project', experimental: { reminders: true } };
});

mock.module('../../internal/lib/use-project-can', () => ({
  useProjectCan: () => ({ allowed, isLoading: loading }),
}));
const sdk = await import('@kortix/sdk');
mock.module('@kortix/sdk', () => ({ ...sdk, updateFeatureFlag: update }));
const { FeatureGateScreen } = await import('./feature-gate-screen');
let cleanup = () => {};
afterEach(() => {
  cleanup();
  update.mockClear();
  allowed = true;
  loading = false;
  failed = false;
});
function Surface({ internalOnly }: { internalOnly: boolean }) {
  const flag = useFeatureFlag('test-project', 'reminders');
  return flag.enabled ? (
    <p>No reminders</p>
  ) : (
    <FeatureGateScreen
      featureKey="reminders"
      featureName="Reminders"
      description="Scheduled check-ins"
      internalOnly={internalOnly}
    />
  );
}
async function render(internalOnly = false) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  client.setQueryData(qk.project.detail('test-project'), {
    project: { experimental: { reminders: false } },
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  cleanup = () => {
    act(() => root.unmount());
    client.clear();
    host.remove();
  };
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <IntlTestProvider><TestUiHost params={{ id: "test-project" }}><Surface internalOnly={internalOnly} /></TestUiHost></IntlTestProvider>
      </QueryClientProvider>,
    ),
  );
  return host;
}
test('the gate enables its own flag without navigating', async () => {
  const host = await render();
  const button = host.querySelector('button');
  expect(host.querySelector('a')?.getAttribute('href')).toContain('feature-flags');
  expect(button).not.toBeNull();
  await act(async () => {
    button?.click();
  });
  expect(update).toHaveBeenCalledWith('test-project', 'reminders', true);
  expect(host.textContent).toContain('No reminders');
});
for (const state of ['denied', 'loading', 'internal']) {
  test(`${state} cannot enable the feature`, async () => {
    allowed = state !== 'denied';
    loading = state === 'loading';
    const host = await render(state === 'internal');
    const button = host.querySelector('button');
    expect(button === null || button.disabled).toBe(true);
    await act(async () => button?.click());
    expect(update).not.toHaveBeenCalled();
  });
}
test('a failed enable stays retryable and reports the failure', async () => {
  failed = true;
  const host = await render();
  await act(async () => host.querySelector('button')?.click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Could not enable reminders');
  expect(host.querySelector('button')?.disabled).toBe(false);
});

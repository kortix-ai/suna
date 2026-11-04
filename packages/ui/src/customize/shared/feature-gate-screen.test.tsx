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
// The project row as the server stores it. The enable writes it; every
// `GET /projects/:id` (the row refetch after the enable) reads it, so no
// response can race the mutation back to `reminders: false`.
let stored = { project_id: 'test-project', experimental: { reminders: false } };
const update = mock(async () => {
  if (failed) throw new Error('Could not enable reminders');
  stored = { project_id: 'test-project', experimental: { reminders: true } };
  return stored;
});
globalThis.fetch = (async () =>
  new Response(JSON.stringify(stored), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

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
  stored = { project_id: 'test-project', experimental: { reminders: false } };
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
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(qk.project.detail('test-project'), { project: stored });
  // `useFeatureFlag` reads the bare row (`qk.project.summary`) since #11651.
  client.setQueryData(qk.project.summary('test-project'), stored);
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

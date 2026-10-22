import { expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query';
import type { AccountHubSheetContent } from '@kortix/ui/internal/account-hub/hub-sheet';

notifyManager.setScheduler(queueMicrotask);
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
let content: AccountHubSheetContent | null = null;
let finish: ((value: { name: string; secret: string }) => void) | undefined;
const requests: object[] = [];
mock.module('@kortix/ui/internal/account-hub/hub-sheet', () => ({
  useInAccountHubSheetBody: () => false,
  useAccountHubSheet: () => ({ open: (value: AccountHubSheetContent) => { content = value; }, close: () => { content = null; } }),
}));
mock.module('@/lib/iam-client', () => ({
  deleteServiceAccountApi: async () => {}, disableServiceAccountApi: async () => {},
  listServiceAccountsApi: async () => [], getPatPolicy: async () => null,
  createServiceAccountApi: (_account: string, input: object) => {
    requests.push(input);
    return new Promise<{ name: string; secret: string }>((resolve) => { finish = resolve; });
  },
}));
const realSelect = await import('@kortix/ui/select');
const pass = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
mock.module('@kortix/ui/select', () => ({ ...realSelect, Select: pass, SelectContent: pass, SelectGroup: pass, SelectItem: pass, SelectLabel: pass, SelectSeparator: pass, SelectTrigger: pass, SelectValue: () => null }));
const { ApiKeysSection } = await import('./api-keys-card');

test('sheet trims names, rejects blank and pending submits, and reveals a completed mint after closing', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let root: ReturnType<typeof create> | undefined;
  await act(async () => { root = create(<QueryClientProvider client={client}><ApiKeysSection accountId="synthetic-account" canManage /></QueryClientProvider>); });
  if (!root) throw new Error('missing section');
  const section = root;
  const button = section.root.findAllByType('button').find((item) => item.props.onClick);
  if (!button) throw new Error('missing create action');
  await act(async () => button.props.onClick());
  if (!content) throw new Error('missing sheet');
  const sheet: AccountHubSheetContent = content;
  let formRoot: ReturnType<typeof create> | undefined;
  await act(async () => { formRoot = create(<QueryClientProvider client={client}>{sheet.body}</QueryClientProvider>); });
  if (!formRoot) throw new Error('missing form');
  const form = formRoot;
  await act(async () => form.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  expect(requests).toHaveLength(0);
  await act(async () => form.root.findByProps({ id: 'service-account-name' }).props.onChange({ target: { value: '  Synthetic token  ' } }));
  await act(async () => form.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  expect(requests).toEqual([{ name: 'Synthetic token' }]);
  await act(async () => form.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  expect(requests).toHaveLength(1);
  await act(async () => form.unmount());
  content = null;
  await act(async () => section.unmount());
  await act(async () => finish?.({ name: 'Synthetic token', secret: 'synthetic-secret' }));
  expect(content).not.toBeNull();
  expect(client.getQueryState(['service-accounts', 'synthetic-account'])?.isInvalidated).toBe(true);
});

 test('explicit expiry is sent by the live sheet', async () => {
  const client = new QueryClient();
  let root: ReturnType<typeof create> | undefined;
  await act(async () => { root = create(<QueryClientProvider client={client}><ApiKeysSection accountId="synthetic-expiry" canManage /></QueryClientProvider>); });
  if (!root) throw new Error('missing section');
  const section = root;
  await act(async () => section.root.findAllByType('button').find((button) => button.props.onClick)?.props.onClick());
  if (!content) throw new Error('missing sheet');
  const sheet: AccountHubSheetContent = content;
  let mounted: ReturnType<typeof create> | undefined;
  await act(async () => { mounted = create(<QueryClientProvider client={client}>{sheet.body}</QueryClientProvider>); });
  if (!mounted) throw new Error('missing form');
  const form = mounted;
  await act(async () => form.root.findByProps({ id: 'service-account-name' }).props.onChange({ target: { value: 'Expiring token' } }));
  const select = form.root.findAll((node) => typeof node.props.onValueChange === 'function')[0];
  if (!select) throw new Error('missing expiry');
  await act(async () => select.props.onValueChange('30'));
  const before = Date.now();
  await act(async () => form.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  expect(JSON.stringify(requests.at(-1))).toContain(new Date(before + 30 * 86400000).toISOString().slice(0, 10));
  await act(async () => { form.unmount(); section.unmount(); });
  await act(async () => finish?.({ name: 'Expiring token', secret: 'synthetic-expiry-secret' }));
});

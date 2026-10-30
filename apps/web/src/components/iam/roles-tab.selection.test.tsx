import { expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create } from 'react-test-renderer';
import type { KebabItem } from '@kortix/ui/access/access/index';
import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
notifyManager.setScheduler(queueMicrotask);
const role = { role_id: 'synthetic-role', key: 'auditor', name: 'Auditor', description: 'Read only', resource_type: 'project', is_system: false, account_id: null };
const realIam = await import('@/lib/iam-client');
mock.module('@/lib/iam-client', () => ({ ...realIam,
  listRoles: async () => [role, { ...role, role_id: 'synthetic-builtin', is_system: true }], getRoleUsage: async () => ({ count: 0 }),
  getRolePermissions: async () => ({ actions: [] }), listPermissions: async () => [],
}));
const pass = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
const realModal = await import('@kortix/ui/modal');
mock.module('@kortix/ui/modal', () => ({ ...realModal, Modal: ({ open, children, onOpenChange }: { open: boolean; children?: React.ReactNode; onOpenChange: (open: boolean) => void }) => open ? <div data-dialog><button onClick={() => onOpenChange(false)}>Close synthetic dialog</button>{children}</div> : null, ModalBody: pass, ModalContent: pass, ModalDescription: pass, ModalFooter: pass, ModalHeader: pass, ModalTitle: pass }));
mock.module('@kortix/ui/hint', () => ({ default: pass, Hint: pass }));
const realSelect = await import('@kortix/ui/select');
mock.module('@kortix/ui/select', () => ({ ...realSelect, Select: pass, SelectContent: pass, SelectItem: pass, SelectTrigger: pass, SelectValue: () => null }));
const access = await import('@kortix/ui/access/access/index');
mock.module('@kortix/ui/access/access/index', () => ({ ...access, RowKebab: ({ items }: { items: KebabItem[] }) => <>{items.map((item, index) => <button key={index} onClick={item.onSelect}>{item.label}</button>)}</> }));
const { RolesTab } = await import('./roles-tab');

test('create closes and reopens with clean fields', async () => {
  let root: ReturnType<typeof create> | undefined;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => { root = create(<QueryClientProvider client={client}><RolesTab accountId="synthetic-account" canManage rbacEnabled /></QueryClientProvider>); });
  if (!root) throw new Error('missing roles');
  const tree = root;
  const click = async (text: string) => {
    const button = tree.root.findAllByType('button').find((item) => item.children.some((child) => typeof child === 'string' && child.includes(text)));
    if (!button) throw new Error(`missing button ${text}`);
    await act(async () => button.props.onClick());
  };
  await click('New role');
  const inputs = () => tree.root.findAllByType('input');
  expect(inputs()[0]?.props.value).toBe('');
  await act(async () => inputs()[0]?.props.onChange({ target: { value: 'Synthetic draft' } }));
  expect(inputs()[0]?.props.value).toBe('Synthetic draft');
  await click('Close synthetic dialog');
  expect(tree.root.findAllByProps({ 'data-dialog': true })).toHaveLength(0);
  await click('New role');
  expect(inputs()[0]?.props.value).toBe('');
  await click('Close synthetic dialog');
  await click('Duplicate');
  expect(inputs()[0]?.props.value).toBe('Auditor copy');
  await click('Close synthetic dialog');
  await click('Edit');
  expect(inputs()[0]?.props.value).toBe('Auditor');
  await click('Close synthetic dialog');
  await click('View');
  expect(inputs()[0]?.props.value).toBe('Auditor');
  expect(inputs()[0]?.props.disabled).toBe(true);
  await act(async () => tree.unmount());
});

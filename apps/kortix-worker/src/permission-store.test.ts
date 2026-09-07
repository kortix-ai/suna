import { expect, test } from 'bun:test';
import { PermissionApprovalStore } from './permission-store.ts';
import type { SessionLogItem } from './session-store.ts';

const approval = { requestId: 'per_1', permission: 'bash', patterns: ['git status*'] };
const entry = {
  kind: 'journal' as const,
  stream: 'kortix.pi.permission-approvals.v1',
  record: approval,
};

test('does not duplicate a committed approval when the UI retries', async () => {
  const items: SessionLogItem[] = [];
  const store = await PermissionApprovalStore.open({
    read: async () => items,
    append: async (item) => {
      items.push(item);
    },
  });
  await store.save(approval);
  await store.save(structuredClone(approval));
  expect(items).toHaveLength(1);
  const snapshot = store.approved();
  snapshot[0]!.patterns.push('*');
  expect(store.approved()).toEqual([approval]);
});

test('rejects corrupted or conflicting durable grants instead of granting broader access', async () => {
  for (const records of [
    [{ ...entry, record: { ...approval, permission: null } }],
    [{ ...entry, record: { ...approval, patterns: [42] } }],
    [entry, { ...entry, record: { ...approval, patterns: ['*'] } }],
  ]) {
    await expect(
      PermissionApprovalStore.open({
        read: async () => records as SessionLogItem[],
        append: async () => {},
      }),
    ).rejects.toThrow('durable permission approval');
  }
});

test('ignores other journal streams and restores exact duplicate approvals once', async () => {
  const store = await PermissionApprovalStore.open({
    read: async () => [
      entry,
      entry,
      { kind: 'journal', stream: 'unrelated', record: { permission: '*', patterns: ['*'] } },
    ],
    append: async () => {},
  });
  expect(store.approved()).toEqual([approval]);
});

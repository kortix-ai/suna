import { expect, test } from 'bun:test';
import { PermissionApprovalStore, SESSION_PERMISSION_STREAM } from './permission-store.ts';
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

test('reset removes earlier always grants and a later retry grants within the new permission epoch', async () => {
  const items: SessionLogItem[] = [];
  const keys: string[] = [];
  const log = {
    read: async () => items,
    append: async (item: SessionLogItem, options?: { idempotencyKey?: string }) => {
      items.push(structuredClone(item));
      keys.push(options!.idempotencyKey!);
    },
  };
  const store = await PermissionApprovalStore.open(log);
  await store.save(approval);
  await store.setRules([]);
  expect(store.approved()).toEqual([]);
  await store.save(approval);
  expect(keys[0]).not.toBe(keys[2]);
  expect((await PermissionApprovalStore.open(log)).approved()).toEqual([approval]);
  await store.setRules([]);
  items.push(structuredClone(items[0]!));
  expect((await PermissionApprovalStore.open(log)).approved()).toEqual([]);
});

test('a reset that races an earlier approval cannot be undone by its late append', async () => {
  const items: SessionLogItem[] = [];
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const log = {
    read: async () => structuredClone(items),
    append: async (item: SessionLogItem) => {
      if (item.kind === 'journal' && item.stream === 'kortix.pi.permission-approvals.v1') {
        entered();
        await blocked;
      }
      items.push(structuredClone(item));
    },
  };
  const store = await PermissionApprovalStore.open(log);
  const save = store.save(approval);
  await started;
  const other = await PermissionApprovalStore.open(log);
  await other.setRules([]);
  release();
  await save;
  expect(store.approved()).toEqual([]);
  expect((await PermissionApprovalStore.open(log)).approved()).toEqual([]);
});

test('failed updates preserve active rules and later refresh observes a different worker', async () => {
  const items: SessionLogItem[] = [];
  let fail = false;
  const log = {
    read: async () => items,
    append: async (item: SessionLogItem) => {
      if (fail) throw new Error('unavailable');
      items.push(structuredClone(item));
    },
  };
  const first = await PermissionApprovalStore.open(log);
  const second = await PermissionApprovalStore.open(log);
  const rules = [{ permission: '*', pattern: '*', action: 'allow' as const }];
  await first.setRules(rules);
  rules[0]!.action = 'deny' as 'allow';
  await second.refresh();
  expect(second.sessionRules()[0]!.action).toBe('allow');
  fail = true;
  await expect(first.setRules([])).rejects.toThrow('unavailable');
  expect(first.sessionRules()).toEqual(second.sessionRules());
  fail = false;
  await first.setRules([]);
  await second.refresh();
  expect(second.sessionRules()).toEqual([]);
});

test('corrupt permission updates fail closed and duplicate settings do not reset later grants', async () => {
  const setting = {
    kind: 'journal' as const,
    stream: SESSION_PERMISSION_STREAM,
    record: { id: 'set_1', rules: [] },
  };
  for (const rules of [
    null,
    {},
    [{ permission: '*', pattern: '*', action: 'oops' }],
    [{ permission: '', pattern: '*', action: 'allow' }],
  ]) {
    await expect(
      PermissionApprovalStore.open({
        read: async () => [{ ...setting, record: { id: 'set_1', rules } } as SessionLogItem],
        append: async () => {},
      }),
    ).rejects.toThrow('permission');
  }
  const saved = { ...entry, record: { ...approval, epoch: 'set_1' } };
  const store = await PermissionApprovalStore.open({
    read: async () => [setting, saved, setting],
    append: async () => {},
  });
  expect(store.approved()).toEqual([approval]);
});

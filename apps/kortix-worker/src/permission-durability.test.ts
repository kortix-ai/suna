import { expect, test } from 'bun:test';
import { PermissionBroker } from './permission-broker.ts';
import { PermissionApprovalStore } from './permission-store.ts';
import type { SessionLogItem } from './session-store.ts';

const request = {
  permission: 'bash',
  patterns: ['git status --short'],
  always: ['git status*'],
  metadata: {},
};

test('always approval commits before a tool resumes and survives a replacement', async () => {
  const items: SessionLogItem[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const store = await PermissionApprovalStore.open({
    read: async () => items,
    append: async (item) => {
      await blocked;
      items.push(structuredClone(item));
    },
  });
  const events: string[] = [];
  const broker = new PermissionBroker({
    sessionId: 'ses_owned',
    permission: { bash: 'ask' },
    publish: (event) => events.push(event.type),
    saveApproval: (approval) => store.save(approval),
    approved: store.approved(),
  });
  let ran = false;
  const tool = broker.authorize(request).then(() => {
    ran = true;
  });
  const reply = broker.reply(broker.list()[0]!.id, 'always');
  await Promise.resolve();
  expect(ran).toBe(false);
  expect(events).toEqual(['permission.asked']);
  release();
  expect(await reply).toBe(true);
  await tool;
  const restored = await PermissionApprovalStore.open({
    read: async () => items,
    append: async () => {
      throw new Error('unexpected write');
    },
  });
  const next = new PermissionBroker({
    sessionId: 'ses_owned',
    permission: { bash: 'ask' },
    publish: () => {
      throw new Error('approval was lost');
    },
    approved: restored.approved(),
  });
  await next.authorize({ ...request, patterns: ['git status --porcelain'] });
  expect(next.list()).toEqual([]);
  expect(items).toHaveLength(1);
});

test('failed durable approval keeps the request pending and never runs the tool', async () => {
  let fail = true;
  const broker = new PermissionBroker({
    sessionId: 'ses_owned',
    permission: { bash: 'ask' },
    publish: () => {},
    saveApproval: async () => {
      if (fail) throw new Error('store unavailable');
    },
  });
  let ran = false;
  const tool = broker.authorize(request).then(() => {
    ran = true;
  });
  const id = broker.list()[0]!.id;
  await expect(broker.reply(id, 'always')).rejects.toThrow(
    'permission approval could not be saved',
  );
  expect(ran).toBe(false);
  expect(broker.list()[0]!.id).toBe(id);
  fail = false;
  expect(await broker.reply(id, 'always')).toBe(true);
  await tool;
});

test('once and rejected permissions do not become durable grants', async () => {
  const saved: unknown[] = [];
  const broker = new PermissionBroker({
    sessionId: 'ses_owned',
    permission: { bash: 'ask' },
    publish: () => {},
    saveApproval: async (approval) => {
      saved.push(approval);
    },
  });
  const once = broker.authorize(request);
  expect(await broker.reply(broker.list()[0]!.id, 'once')).toBe(true);
  await once;
  const rejected = broker.authorize(request);
  const rejectedCheck = rejected.catch((error: Error) => error);
  expect(await broker.reply(broker.list()[0]!.id, 'reject')).toBe(true);
  expect(await rejectedCheck).toMatchObject({
    message: expect.stringContaining('rejected'),
  });
  expect(saved).toEqual([]);
});

test('a stop during approval persistence cannot resume the stopped tool', async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const controller = new AbortController();
  const broker = new PermissionBroker({
    sessionId: 'ses_owned',
    permission: { bash: 'ask' },
    publish: () => {},
    saveApproval: () => blocked,
  });
  const tool = broker.authorize({ ...request, signal: controller.signal });
  const check = tool.catch((error: Error) => error);
  const reply = broker.reply(broker.list()[0]!.id, 'always');
  controller.abort(new Error('stopped'));
  release();
  expect(await check).toMatchObject({ message: 'stopped' });
  expect(await reply).toBe(false);
  expect(broker.list()).toEqual([]);
});

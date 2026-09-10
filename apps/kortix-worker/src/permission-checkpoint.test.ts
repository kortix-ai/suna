import { expect, test } from 'bun:test';
import { PermissionCheckpointStore } from './permission-checkpoint.ts';
import type { SessionLogItem } from './session-store.ts';

const request = {
  id: 'per_primary',
  sessionID: 'ses_one',
  permission: 'bash',
  patterns: ['cat /etc/hostname'],
  always: ['cat /etc/hostname'],
  metadata: { command: 'cat /etc/hostname' },
  tool: { messageID: 'msg_assistant', callID: 'msg_assistant-p0' },
};
const external = {
  ...request,
  id: 'per_external',
  permission: 'external_directory',
  patterns: ['/etc/hostname'],
  always: ['/etc/hostname'],
  metadata: { tool: 'bash', paths: ['/etc/hostname'] },
};

function setup() {
  const items: SessionLogItem[] = [];
  const log = {
    read: async () => structuredClone(items),
    append: async (item: SessionLogItem) => {
      items.push(structuredClone(item));
    },
  };
  return { items, log, store: new PermissionCheckpointStore(log) };
}

test('restores every authorization stage until the tool execution boundary is released', async () => {
  const { store, log, items } = setup();
  await store.open('msg_user', 'native_call', 'primary', request);
  expect(await new PermissionCheckpointStore(log).active('msg_user')).toMatchObject([
    { request, stage: 'primary', resolution: null, released: false },
  ]);
  await store.resolve(request.id, { reply: 'once' });
  await store.open('msg_user', 'native_call', 'external_directory', external);
  const replacement = new PermissionCheckpointStore(log);
  expect(await replacement.active('msg_user')).toMatchObject([
    { request, resolution: { reply: 'once' } },
    { request: external, resolution: null },
  ]);
  expect(
    await replacement.open('msg_user', 'native_call', 'primary', { ...request, id: 'per_new' }),
  ).toMatchObject({ request, resolution: { reply: 'once' } });
  expect(items).toHaveLength(3);
  await expect(replacement.release('msg_user', 'native_call', request.tool)).rejects.toThrow(
    /unresolved/,
  );
  await replacement.resolve(external.id, { reply: 'always' });
  await replacement.release('msg_user', 'native_call', request.tool);
  expect(await new PermissionCheckpointStore(log).active('msg_user')).toEqual([]);
  expect(items).toHaveLength(5);
});

test('preserves a rejected response and rejects conflicting answers or request metadata', async () => {
  const { store, log } = setup();
  await store.open('msg_user', 'native_call', 'primary', request);
  await store.resolve(request.id, { reply: 'reject', message: 'Use a different path.' });
  expect(await new PermissionCheckpointStore(log).active('msg_user')).toMatchObject([
    { resolution: { reply: 'reject', message: 'Use a different path.' } },
  ]);
  await expect(store.resolve(request.id, { reply: 'once' })).rejects.toThrow(/conflicting/);
  await expect(
    store.open('msg_user', 'native_call', 'primary', {
      ...request,
      patterns: ['changed'],
    }),
  ).rejects.toThrow(/conflicting/);
  await store.release('msg_user', 'native_call', request.tool);
  await expect(store.open('msg_user', 'native_call', 'primary', request)).rejects.toThrow(
    /released/,
  );
});

test('allows a later tool batch to reuse a native call ID without reusing its approval', async () => {
  const { store } = setup();
  await store.open('msg_user', 'native_call', 'primary', request);
  await store.resolve(request.id, { reply: 'once' });
  await store.release('msg_user', 'native_call', request.tool);
  const later = {
    ...request,
    id: 'per_later',
    tool: { messageID: 'msg_later', callID: 'msg_later-p0' },
  };
  expect(await store.open('msg_user', 'native_call', 'primary', later)).toMatchObject({
    request: later,
    resolution: null,
  });
});

test('keeps failed responses retryable and rejects overlapping tool boundaries', async () => {
  const { store, log, items } = setup();
  await store.open('msg_user', 'native_call', 'primary', request);
  await expect(
    store.open('msg_user', 'native_call', 'external_directory', external),
  ).rejects.toThrow(/unresolved/);
  await expect(
    store.open('msg_user', 'other_call', 'primary', { ...request, id: 'per_other' }),
  ).rejects.toThrow(/active/);
  const append = log.append;
  log.append = async () => {
    throw new Error('offline');
  };
  await expect(store.resolve(request.id, { reply: 'once' })).rejects.toThrow('offline');
  expect(await store.active('msg_user')).toMatchObject([{ resolution: null }]);
  log.append = append;
  await store.resolve(request.id, { reply: 'once' });
  await store.resolve(request.id, { reply: 'once' });
  expect(items).toHaveLength(2);
});

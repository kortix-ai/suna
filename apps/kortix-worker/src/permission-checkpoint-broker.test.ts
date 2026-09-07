import { expect, test } from 'bun:test';
import { PermissionBroker, PermissionRejectedError } from './permission-broker.ts';
import { PermissionCheckpointStore } from './permission-checkpoint.ts';
import type { SessionLogItem } from './session-store.ts';

const tool = { messageID: 'msg_assistant', callID: 'msg_assistant-p0' };
const input = {
  permission: 'bash',
  patterns: ['cat /etc/hostname'],
  always: ['cat /etc/hostname'],
  metadata: { command: 'cat /etc/hostname' },
  tool,
  toolCallId: 'native_call',
  stage: 'primary' as const,
};
function setup() {
  const items: SessionLogItem[] = [];
  const events: string[] = [];
  const approvals: any[] = [];
  const log = {
    read: async () => structuredClone(items),
    append: async (item: SessionLogItem) => {
      items.push(structuredClone(item));
    },
  };
  const store = new PermissionCheckpointStore(log);
  let next = 0;
  const broker = () =>
    new PermissionBroker({
      sessionId: 'ses_one',
      permission: { bash: 'ask', external_directory: 'ask' },
      createId: () => `per_${++next}`,
      publish: (event) => events.push(event.type),
      approved: approvals,
      saveApproval: async (approval) => {
        approvals.push(approval);
      },
      persistence: {
        open: (request, callId, stage) => store.open('msg_user', callId, stage, request),
        resolve: (id, resolution) => store.resolve(id, resolution),
        release: (callId, tool) => store.release('msg_user', callId, tool),
      },
    });
  return { items, events, approvals, log, store, broker };
}
async function pending(broker: PermissionBroker) {
  for (let n = 0; n < 100; n++) {
    if (broker.list().length) return broker.list()[0]!;
    await Bun.sleep(1);
  }
  throw new Error('permission did not become pending');
}

test('commits before publishing, preserves failed responses, and releases before tool execution', async () => {
  const { log, store, events, broker } = setup();
  const first = broker();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const append = log.append;
  log.append = async (item) => {
    await gate;
    await append(item);
  };
  const result = first.authorize(input);
  expect(first.list()).toEqual([]);
  expect(events).toEqual([]);
  release();
  const request = await pending(first);
  log.append = async () => {
    throw new Error('offline');
  };
  await expect(first.reply(request.id, 'once')).rejects.toThrow(/could not be saved/);
  expect(first.list()).toEqual([request]);
  expect(await store.active('msg_user')).toMatchObject([{ resolution: null }]);
  log.append = append;
  await first.reply(request.id, 'once');
  await result;
  expect(await store.active('msg_user')).toMatchObject([{ resolution: { reply: 'once' } }]);
  await first.releaseTool(input.toolCallId, tool);
  expect(await store.active('msg_user')).toEqual([]);
});

test.each(['once', 'always', 'reject'] as const)(
  'restores a committed %s response without another question',
  async (reply) => {
    const { broker, store, events, approvals } = setup();
    const request = {
      id: 'per_saved',
      sessionID: 'ses_one',
      permission: input.permission,
      patterns: input.patterns,
      always: input.always,
      metadata: input.metadata,
      tool,
    };
    await store.open('msg_user', input.toolCallId, input.stage, request);
    await store.resolve(request.id, {
      reply,
      ...(reply === 'reject' ? { message: 'Different path.' } : {}),
    });
    if (reply === 'always')
      approvals.push({
        requestId: request.id,
        permission: input.permission,
        patterns: input.always,
      });
    const restored = broker();
    restored.restoreCheckpoints(await store.active('msg_user'));
    const result = restored.authorize(input);
    if (reply === 'reject') await expect(result).rejects.toBeInstanceOf(PermissionRejectedError);
    else await result;
    expect(events).toEqual([]);
    await restored.releaseTool(input.toolCallId, tool);
    expect(await store.active('msg_user')).toEqual([]);
  },
);

test('a saved grant cannot bypass an unacknowledged permission checkpoint after replacement', async () => {
  const { broker, store, approvals } = setup();
  const request = {
    id: 'per_saved',
    sessionID: 'ses_one',
    permission: input.permission,
    patterns: input.patterns,
    always: input.always,
    metadata: input.metadata,
    tool,
  };
  await store.open('msg_user', input.toolCallId, input.stage, request);
  approvals.push({ requestId: request.id, permission: input.permission, patterns: input.always });
  const restored = broker();
  restored.restoreCheckpoints(await store.active('msg_user'));
  const result = restored.authorize(input);
  expect(await pending(restored)).toEqual(request);
  await restored.reply(request.id, 'once');
  await result;
  await restored.releaseTool(input.toolCallId, tool);
});

test('restores the earlier once approval before the pending external-directory stage', async () => {
  const { broker, store } = setup();
  const request = {
    id: 'per_primary',
    sessionID: 'ses_one',
    permission: input.permission,
    patterns: input.patterns,
    always: input.always,
    metadata: input.metadata,
    tool,
  };
  await store.open('msg_user', input.toolCallId, input.stage, request);
  await store.resolve(request.id, { reply: 'once' });
  const external = {
    ...request,
    id: 'per_external',
    permission: 'external_directory',
    patterns: ['/etc/hostname'],
    always: ['/etc/hostname'],
    metadata: { paths: ['/etc/hostname'] },
  };
  await store.open('msg_user', input.toolCallId, 'external_directory', external);
  const restored = broker();
  restored.restoreCheckpoints(await store.active('msg_user'));
  await restored.authorize(input);
  expect(restored.list()).toEqual([]);
  const result = restored.authorize({
    ...external,
    toolCallId: input.toolCallId,
    stage: 'external_directory',
  });
  expect(await pending(restored)).toEqual(external);
  await restored.reply(external.id, 'once');
  await result;
  await restored.releaseTool(input.toolCallId, tool);
  expect(await store.active('msg_user')).toEqual([]);
});

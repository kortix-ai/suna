import { expect, test } from 'bun:test';
import { DurableSessionStorage, type SessionLog, type SessionLogItem } from './session-store';
import { projectPiHistory } from '../../../packages/shared/src/pi-history';

function entry(id: string, text = id): Extract<SessionLogItem, { kind: 'entry' }> {
  return {
    kind: 'entry', lane: 'main',
    entry: { id, type: 'message', message: { role: 'user', content: [{ type: 'text', text }], timestamp: 1 } },
  };
}

function stage(): Extract<SessionLogItem, { action: 'stage' }> {
  return { kind: 'history', version: 1, revision: 0, action: 'stage', fromLeaf: 'e2', toLeaf: 'e1', messageId: 'u2', hiddenMessageIds: ['u2', 'a2'] };
}

function memoryLog(items: SessionLogItem[]): SessionLog {
  return { read: async () => structuredClone(items), append: async item => { items.push(structuredClone(item)); } };
}

const metadata = { id: 'ses_pi-history', createdAt: 1 };

test('one durable history append restores the native branch and exact wire visibility after process replacement', async () => {
  const items = [entry('e1'), entry('e2'), stage()];
  const { storage, logItems } = await DurableSessionStorage.open(metadata, memoryLog(items));
  expect(await storage.getLanes()).toEqual([{ lane: 'main', leafId: 'e1' }]);
  expect(await storage.getEntry('e2')).toMatchObject({ id: 'e2', parentId: 'e1' });
  expect([...projectPiHistory(logItems).hiddenMessageIds]).toEqual(['u2', 'a2']);
  expect(items).toHaveLength(3);
  await storage.appendEntry(entry('e3').entry, 'main');
  const reopened = await DurableSessionStorage.open(metadata, memoryLog(items));
  expect(await reopened.storage.getEntry('e3')).toMatchObject({ parentId: 'e1' });
});

test('restore reattaches the original native branch without duplicating entries', async () => {
  const items: SessionLogItem[] = [entry('e1'), entry('e2'), stage(), { kind: 'history', version: 1, revision: 1, action: 'restore' }];
  const { storage, logItems } = await DurableSessionStorage.open(metadata, memoryLog(items));
  expect(await storage.getLanes()).toEqual([{ lane: 'main', leafId: 'e2' }]);
  expect((await storage.findEntries()).map(item => item.id).sort()).toEqual(['e1', 'e2']);
  expect(projectPiHistory(logItems).hiddenMessageIds.size).toBe(0);
});

test.each(['missing', 'sibling'])('replay refuses an invalid rewind target %s', async target => {
  const transition = { ...stage(), toLeaf: target };
  const items: SessionLogItem[] = [entry('e1'), entry('sibling'), { kind: 'lane_move', lane: 'main', to: 'e1' }, entry('e2'), transition];
  await expect(DurableSessionStorage.open(metadata, memoryLog(items))).rejects.toThrow('ancestor');
});

test('replay refuses history written against a different native leaf', async () => {
  const items: SessionLogItem[] = [entry('e1'), entry('e2'), { ...stage(), fromLeaf: 'e1' }];
  await expect(DurableSessionStorage.open(metadata, memoryLog(items))).rejects.toThrow('current branch');
});

test('restore refuses native branch drift while a rewind is staged', async () => {
  const items: SessionLogItem[] = [entry('e1'), entry('e2'), stage(), entry('unadmitted'), { kind: 'history', version: 1, revision: 1, action: 'restore' }];
  await expect(DurableSessionStorage.open(metadata, memoryLog(items))).rejects.toThrow('current branch');
});

test('rewind to the start preserves an empty main branch across restart', async () => {
  const items: SessionLogItem[] = [entry('e1'), entry('e2'), { ...stage(), toLeaf: null }];
  const { storage } = await DurableSessionStorage.open(metadata, memoryLog(items));
  expect(await storage.getLanes()).toEqual([{ lane: 'main', leafId: null }]);
});

test('prepared operations do not move the native leaf until commit; cancellation preserves it', async () => {
  const operationId = crypto.randomUUID();
  const prepared = { kind: 'history' as const, version: 1 as const, revision: 0, action: 'prepare' as const, operationId, selection: stage(), workspace: null };
  const items: SessionLogItem[] = [entry('e1'), entry('e2'), prepared];
  expect(await (await DurableSessionStorage.open(metadata, memoryLog(items))).storage.getLanes()).toEqual([{ lane: 'main', leafId: 'e2' }]);
  items.push({ kind: 'history', version: 1, revision: 1, action: 'commit', operationId });
  expect(await (await DurableSessionStorage.open(metadata, memoryLog(items))).storage.getLanes()).toEqual([{ lane: 'main', leafId: 'e1' }]);
  items[3] = { kind: 'history', version: 1, revision: 1, action: 'cancel', operationId };
  expect(await (await DurableSessionStorage.open(metadata, memoryLog(items))).storage.getLanes()).toEqual([{ lane: 'main', leafId: 'e2' }]);
});

test('committed preparation still requires a native ancestor', async () => {
  const operationId = crypto.randomUUID();
  const items: SessionLogItem[] = [entry('e1'), entry('e2'), { kind: 'history', version: 1, revision: 0, action: 'prepare', operationId, selection: { ...stage(), toLeaf: 'missing' }, workspace: null }, { kind: 'history', version: 1, revision: 1, action: 'commit', operationId }];
  await expect(DurableSessionStorage.open(metadata, memoryLog(items))).rejects.toThrow('ancestor');
});

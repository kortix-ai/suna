import { expect, test } from 'bun:test';
import { SessionRewind } from './session-rewind';
import { projectPiHistory, validatePiHistoryControlAppend } from '../../../packages/shared/src/pi-history';
import type { SessionLog, SessionLogItem } from './session-store';
const operationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const move = { operationId, environmentId: 'env', from: 'a'.repeat(64), to: 'b'.repeat(64) };
const selection = { kind: 'history' as const, version: 1 as const, revision: 0, action: 'stage' as const, messageId: 'u', fromLeaf: 'end', toLeaf: null, hiddenMessageIds: ['u', 'a'] };
function fixture() {
  const items: SessionLogItem[] = [];
  const log: SessionLog = {
    read: async () => structuredClone(items),
    append: async (item, options) => {
      const existing = items.find(value => value._kortixAppendId === options?.idempotencyKey);
      if (existing) { expect(existing).toEqual({ ...item, _kortixAppendId: options!.idempotencyKey }); return; }
      validatePiHistoryControlAppend(items, item);
      items.push({ ...structuredClone(item), _kortixAppendId: options?.idempotencyKey });
    },
  };
  return { items, log };
}
test('history remains visible and admissions are fenced until the file move completes', async () => {
  const { items, log } = fixture();
  const rewind = new SessionRewind(log, {
    apply: async () => {
      expect(projectPiHistory(items).pending?.operationId).toBe(operationId);
      expect(projectPiHistory(items).hiddenMessageIds.size).toBe(0);
      return { ...move, status: 'complete', changedPaths: ['a'] };
    }, abort: async () => { throw new Error('unexpected abort'); },
  });
  await rewind.prepare(selection, move, operationId);
  expect([...projectPiHistory(items).hiddenMessageIds]).toEqual(['u', 'a']);
  expect(projectPiHistory(items).pending).toBeNull();
});
test('a preflight conflict releases the admission fence only after durable cancellation', async () => {
  const { items, log } = fixture();
  await expect(new SessionRewind(log, { apply: async () => { throw new Error('manual edit conflict'); }, abort: async () => ({ ...move, status: 'cancelled', changedPaths: [] }) }).prepare(selection, move, operationId)).rejects.toThrow('manual edit conflict');
  expect(projectPiHistory(items).pending).toBeNull();
  expect(projectPiHistory(items).hiddenMessageIds.size).toBe(0);
});
test('lost file receipts keep admissions blocked and a replacement coordinator resumes the same operation', async () => {
  const { items, log } = fixture();
  const offline = async () => { throw new Error('connection lost'); };
  await expect(new SessionRewind(log, { apply: offline, abort: offline }).prepare(selection, move, operationId)).rejects.toThrow('pending');
  expect(projectPiHistory(items).pending).not.toBeNull();
  await new SessionRewind(log, { apply: async request => { expect(request).toEqual(move); return { ...move, status: 'complete', changedPaths: [] }; }, abort: offline }).recover();
  expect(projectPiHistory(items).pending).toBeNull();
  expect(projectPiHistory(items).staged?.messageId).toBe('u');
});
test('a competing completion wins over cancellation after a lost response', async () => {
  const { items, log } = fixture();
  await new SessionRewind(log, { apply: async () => { throw new Error('lost response'); }, abort: async () => ({ ...move, status: 'complete', changedPaths: [] }) }).prepare(selection, move, operationId);
  expect(projectPiHistory(items).staged?.messageId).toBe('u');
});

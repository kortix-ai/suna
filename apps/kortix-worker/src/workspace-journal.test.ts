import { expect, test } from 'bun:test';
import { workspaceJournalItem as row, workspaceUndoPlan } from './workspace-journal';
const a = 'a'.repeat(64), b = 'b'.repeat(64), c = 'c'.repeat(64);
const covered = row({ type: 'covered', messageId: 'u' });
const begin = (id: string, environmentId = 'env') => row({ type: 'begin', messageId: 'u', operationId: id, environmentId });
const end = (id: string, from: string, to: string) => row({ type: 'end', messageId: 'u', operationId: id, workspace: { from, to } });
const ids = new Set(['u']);
test('text-only turns need coverage and do not need an environment', () => {
  expect(workspaceUndoPlan([covered], ids)).toBeNull();
  expect(() => workspaceUndoPlan([], ids)).toThrow('predates');
});
test('rollback composes only selected completed operations in reverse execution order', () => {
  expect(workspaceUndoPlan([covered, begin('1'), end('1', a, b), begin('2'), end('2', b, c)], ids)).toEqual({ environmentId: 'env', moves: [{ from: c, to: b }, { from: b, to: a }] });
});
test('crashed, uncheckpointed, and replaced environments refuse rewind', () => {
  expect(() => workspaceUndoPlan([covered, begin('1')], ids)).toThrow('incomplete');
  expect(() => workspaceUndoPlan([covered, begin('1'), row({ type: 'end', messageId: 'u', operationId: '1', workspace: null })], ids)).toThrow('incomplete');
  expect(() => workspaceUndoPlan([covered, begin('1'), end('1', a, b), begin('2', 'replacement'), end('2', b, c)], ids)).toThrow('replacement');
});

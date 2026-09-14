import { expect, test } from 'bun:test';
import { projectPiHistory, validatePiHistoryTransition, validatePiHistoryControlAppend } from './pi-history';

const accepted = (id: string) => ({ kind: 'journal', stream: 'kortix.pi.turn-admission.v1', record: { type: 'accepted', turn: { messageId: id } } });
const completed = (id: string) => ({ kind: 'journal', stream: 'kortix.pi.turn-admission.v1', record: { type: 'completed', messageId: id } });
const stage = (revision: number, messageId = 'u2', fromLeaf = 'e4', toLeaf: string | null = 'e2', hiddenMessageIds = ['u2', 'a2']) => ({ kind: 'history', version: 1, revision, action: 'stage', messageId, fromLeaf, toLeaf, hiddenMessageIds });
const restore = (revision: number) => ({ kind: 'history', version: 1, revision, action: 'restore' });
const base = [accepted('u1'), completed('u1'), accepted('u2'), completed('u2')];

test('staging and restoring preserve one reversible model branch and exact hidden identities', () => {
  const staged = projectPiHistory([...base, stage(2)]);
  expect(staged.revision).toBe(3);
  expect(staged.staged).toMatchObject({ messageId: 'u2', originalLeaf: 'e4', leaf: 'e2' });
  expect([...staged.hiddenMessageIds]).toEqual(['u2', 'a2']);
  const restored = projectPiHistory([...base, stage(2), restore(3)]);
  expect(restored.staged).toBeNull();
  expect([...restored.hiddenMessageIds]).toEqual([]);
  expect(restored.laneMoves).toEqual([{ index: 4, from: 'e4', to: 'e2' }, { index: 5, from: 'e2', to: 'e4' }]);
});

test('a new accepted prompt commits the hidden branch and prevents a later restore', () => {
  const log = [...base, stage(2), accepted('u3'), completed('u3')];
  const state = projectPiHistory(log);
  expect(state.staged).toBeNull();
  expect([...state.hiddenMessageIds]).toEqual(['u2', 'a2']);
  expect(state.revision).toBe(4);
  expect(() => validatePiHistoryTransition(log, restore(4))).toThrow('nothing to restore');
});

test('an earlier rewind retains the original head and restores every staged message', () => {
  const log = [...base, stage(2), stage(3, 'u1', 'e2', null, ['u1', 'a1'])];
  expect(projectPiHistory(log).staged).toMatchObject({ originalLeaf: 'e4', leaf: null });
  expect([...projectPiHistory([...log, restore(4)]).hiddenMessageIds]).toEqual([]);
});

test('restore does not resurrect a branch committed before the current rewind', () => {
  const log = [...base, stage(2), accepted('u3'), completed('u3'), stage(4, 'u3', 'e6', 'e2', ['u3', 'a3']), restore(5)];
  expect([...projectPiHistory(log).hiddenMessageIds]).toEqual(['u2', 'a2']);
});

test('duplicate accepted records and duplicate history retries advance once', () => {
  const event = { ...stage(2), _kortixAppendId: 'same' };
  const state = projectPiHistory([...base, accepted('u2'), event, event]);
  expect(state.revision).toBe(3);
  expect(state.laneMoves).toHaveLength(1);
});

test('a refused or cancelled prompt does not commit a staged branch unless it was admitted', () => {
  const state = projectPiHistory([...base, stage(2), completed('unknown')]);
  expect(state.staged?.messageId).toBe('u2');
});

test.each(['accepted', 'started'])('rewind refuses an unfinished %s turn', status => {
  const log = [...base, accepted('u3'), { kind: 'journal', stream: 'kortix.pi.turn-admission.v1', record: { type: status, messageId: 'u3' } }];
  expect(() => validatePiHistoryTransition(log, stage(3))).toThrow('unfinished turn');
});

test('a cancelled queued turn is terminal for the history mutation gate', () => {
  const log = [...base, accepted('u3'), { kind: 'journal', stream: 'kortix.pi.turn-admission.v1', record: { type: 'cancelled', messageId: 'u3' } }];
  expect(validatePiHistoryTransition(log, stage(3))).toMatchObject({ revision: 3 });
});

test.each([
  { ...stage(2), revision: 1 },
  { ...stage(2), version: 2 },
  { ...stage(2), toLeaf: 42 },
  { ...stage(2), hiddenMessageIds: ['a2'] },
  { ...stage(2), hiddenMessageIds: ['u2', 'u2'] },
  { ...stage(2), hiddenMessageIds: ['u2', 42] },
  { ...stage(2), fromLeaf: '' },
])('rejects invalid or stale history transitions %j', event => {
  expect(() => validatePiHistoryTransition(base, event)).toThrow();
});

test('a second stage cannot claim a different current branch', () => {
  expect(() => validatePiHistoryTransition([...base, stage(2)], stage(3, 'u1', 'wrong', null, ['u1']))).toThrow('current branch');
});

test('legacy prompt acceptance remains compatible until the first rewind', () => {
  expect(() => validatePiHistoryControlAppend(base, accepted('u3'))).not.toThrow();
  expect(() => validatePiHistoryControlAppend([...base, stage(2)], accepted('u3'))).toThrow('history revision is required');
});

test('new prompt acceptance competes with rewind at the observed revision', () => {
  const event = { ...accepted('u3'), record: { ...accepted('u3').record, historyRevision: 2 } };
  expect(() => validatePiHistoryControlAppend(base, event)).not.toThrow();
  expect(() => validatePiHistoryControlAppend([...base, stage(2)], event)).toThrow('history revision changed');
  expect(() => validatePiHistoryControlAppend([...base, accepted('u3')], stage(2))).toThrow('history revision changed');
});

test.each([-1, 1.5, '2', null])('rejects a malformed admission revision %j', historyRevision => {
  const event = { ...accepted('u3'), record: { ...accepted('u3').record, historyRevision } };
  expect(() => validatePiHistoryControlAppend(base, event)).toThrow('invalid admission history revision');
});

test('rejects a conflicting duplicate history identity during replay', () => {
  const first = { ...stage(2), _kortixAppendId: 'same' };
  expect(() => projectPiHistory([...base, first, { ...first, toLeaf: null }])).toThrow('conflicting history append identity');
});

test('rejects staging committed hidden identities instead of resurrecting them on restore', () => {
  const log = [...base, stage(2), accepted('u3'), completed('u3')];
  expect(() => validatePiHistoryTransition(log, stage(4, 'u3', 'e6', 'e2', ['u3', 'u2']))).toThrow('committed hidden message');
});

test('ignores other journal streams when checking unfinished turns', () => {
  expect(() => validatePiHistoryTransition([...base, { ...accepted('other'), stream: 'other' }], stage(2))).not.toThrow();
});

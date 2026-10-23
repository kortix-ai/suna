import { describe, expect, test } from 'bun:test';
import { planUndo, type Snapshot, type UndoVersion } from './undo';

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  type: 'decisions',
  title: 'Pricing',
  summary: '',
  body: 'v1',
  status: 'confirmed',
  related: [],
  deleted: false,
  ...over,
});
const version = (pageId: string, versionNo: number, over: Partial<UndoVersion> = {}): UndoVersion => ({
  ...snap(),
  versionId: `${pageId}-v${versionNo}`,
  pageId,
  versionNo,
  undone: false,
  ...over,
});

describe('undo plans', () => {
  test('undo of a create sends the page to the trash', () => {
    const plan = planUndo([version('p', 1)], new Map([['p', null]]), new Set());
    expect(plan).toEqual({ steps: [{ pageId: 'p', undoes: 'p-v1', snapshot: snap({ deleted: true }) }] });
  });

  test('undo of an update restores the version before it', () => {
    const plan = planUndo([version('p', 2, { body: 'v2' })], new Map([['p', snap({ body: 'v1' })]]), new Set());
    expect(plan).toEqual({ steps: [{ pageId: 'p', undoes: 'p-v2', snapshot: snap({ body: 'v1' }) }] });
  });

  test('undo of a delete brings the page back live', () => {
    const plan = planUndo([version('p', 3, { deleted: true })], new Map([['p', snap()]]), new Set());
    expect('steps' in plan && plan.steps[0]!.snapshot.deleted).toBe(false);
  });

  test('undo of a file_note restores the note and the page it was filed into, together', () => {
    const change = [version('page', 4, { body: 'v1\n- filed' }), version('note', 2, { type: 'note', deleted: true })];
    const plan = planUndo(change, new Map([['page', snap()], ['note', snap({ type: 'note', title: 'Launch Nov 12' })]]), new Set());
    expect(plan).toEqual({
      steps: [
        { pageId: 'page', undoes: 'page-v4', snapshot: snap() },
        { pageId: 'note', undoes: 'note-v2', snapshot: snap({ type: 'note', title: 'Launch Nov 12' }) },
      ],
    });
  });

  test('the trap case: a note filed into a new page of its own title; undo trashes the page before the note comes back', () => {
    const change = [version('note', 2, { type: 'note', title: 'Launch date', deleted: true }), version('page', 1, { title: 'Launch date' })];
    const plan = planUndo(change, new Map([['note', snap({ type: 'note', title: 'Launch date' })], ['page', null]]), new Set());
    expect('steps' in plan && plan.steps.map((step) => [step.pageId, step.snapshot.deleted])).toEqual([
      ['page', true],
      ['note', false],
    ]);
  });

  test('a change with a newer version on any of its pages is superseded; an undone one is already undone', () => {
    const change = [version('page', 4), version('note', 2)];
    const previous = new Map([['page', snap()], ['note', snap()]]);
    expect(planUndo(change, previous, new Set(['note']))).toEqual({ error: 'superseded' });
    expect(planUndo([version('p', 2, { undone: true })], previous, new Set())).toEqual({ error: 'already_undone' });
  });
});

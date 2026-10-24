import { describe, expect, test } from 'bun:test';
import {
  MemoryChangeListSchema,
  MemoryDeleteResultSchema,
  MemoryLayerKeySchema,
  MemoryLayerSchema,
  MemoryPageCreateInputSchema,
  MemoryPageUpdateInputSchema,
  MemoryUndoResultSchema,
  MemoryVersionListSchema,
} from '../index';

describe('page inputs', () => {
  test('create takes a filed type or other, never note', () => {
    expect(MemoryPageCreateInputSchema.safeParse({ title: 'x', type: 'other' }).success).toBe(true);
    expect(MemoryPageCreateInputSchema.safeParse({ title: 'x', type: 'people', agent_folder: false }).success).toBe(true);
    expect(MemoryPageCreateInputSchema.safeParse({ title: 'x', type: 'note' }).success).toBe(false);
  });

  test('related takes page ids, not only uuids', () => {
    expect(MemoryPageCreateInputSchema.safeParse({ title: 'x', type: 'other', related: ['Y29tcGFueQpwZW9wbGUvcHJpeWEubWQ'] }).success).toBe(true);
  });

  test('update edits the body only', () => {
    expect(MemoryPageUpdateInputSchema.safeParse({ base_version: 1792863059013, body: 'a' }).success).toBe(true);
    expect(MemoryPageUpdateInputSchema.safeParse({ base_version: 1, body: 'a', title: 'New' }).success).toBe(false);
    expect(MemoryPageUpdateInputSchema.safeParse({ base_version: 1 }).success).toBe(false);
  });
});

test('a layer key is company or a space uuid', () => {
  expect(MemoryLayerKeySchema.safeParse('company').success).toBe(true);
  expect(MemoryLayerKeySchema.safeParse('6f1c0a8e-2b4d-4c3a-9e7f-1a2b3c4d5e6f').success).toBe(true);
  expect(MemoryLayerKeySchema.safeParse('general').success).toBe(false);
});

test('a layer names its folder', () => {
  const counts = { people: 0, decisions: 1, workstreams: 0, playbooks: 0, note: 0, other: 2, unconfirmed: 0, trash: 0 };
  const layer = {
    layer_id: 'company', scope: 'company', space_id: null, name: 'Company', counts, read_only: false, can_write: true,
    folder: '/Company/Memory', agent_folder: null, drive_id: 'd1', other_files: 3,
  };
  expect(MemoryLayerSchema.safeParse(layer).success).toBe(true);
  expect(MemoryLayerSchema.safeParse({ ...layer, folder: undefined }).success).toBe(false);
});

test('changes and history page with next; delete and undo results', () => {
  expect(MemoryChangeListSchema.safeParse({ changes: [], next: null }).success).toBe(true);
  expect(MemoryChangeListSchema.safeParse({ changes: [] }).success).toBe(false);
  const author = { kind: 'agent', user_id: null, name: null, agent: 'writer' };
  const version = {
    version_id: 'v2', change_id: 'c2', version_no: 2, op: 'update', author, source: null,
    created_at: '2026-10-23T00:00:00Z', undone: false, can_undo: true,
    snapshot: { type: 'other', title: 'Priya', summary: '', body: 'a', status: 'confirmed', related: [], deleted: false },
  };
  expect(MemoryVersionListSchema.safeParse({ versions: [version], next: null }).success).toBe(true);
  expect(MemoryDeleteResultSchema.safeParse({ ok: true, version_id: 'v3' }).success).toBe(true);
  expect(MemoryUndoResultSchema.safeParse({ pages: [] }).success).toBe(true);
});

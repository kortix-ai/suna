import { describe, expect, test } from 'bun:test';
import {
  MemoryChangeListSchema,
  MemoryDeleteResultSchema,
  MemoryLayerExportSchema,
  MemoryLayerKeySchema,
  MemoryPageCreateInputSchema,
  MemoryRememberInputSchema,
  MemoryRememberResultSchema,
  MemoryTurnLayersSchema,
  MemoryUndoResultSchema,
  MemoryVersionListSchema,
} from '../index';

describe('MemoryRememberInputSchema', () => {
  test('accepts the body the remember tool sends', () => {
    const body = {
      title: 'Priya',
      type: 'people',
      fact: 'Priya owns the Q4 launch.',
      section: 'Role',
      layer: 'company',
      outside: { label: 'example.test', url: 'https://example.test/a' },
    } as const;
    expect(MemoryRememberInputSchema.parse(body)).toEqual(body);
  });

  test('needs exactly one of fact and body', () => {
    const base = { title: 'Q4 launch', type: 'workstreams' };
    expect(MemoryRememberInputSchema.safeParse(base).success).toBe(false);
    expect(MemoryRememberInputSchema.safeParse({ ...base, fact: 'a', body: 'b' }).success).toBe(false);
    expect(MemoryRememberInputSchema.safeParse({ ...base, body: '## Status\nOn track' }).success).toBe(true);
  });

  test('a summary is one line', () => {
    const base = { title: 'Priya', type: 'people', fact: 'a' } as const;
    expect(MemoryRememberInputSchema.safeParse({ ...base, summary: 'Owns launch' }).success).toBe(true);
    expect(MemoryRememberInputSchema.safeParse({ ...base, summary: 'Owns\nlaunch' }).success).toBe(false);
  });

  test('a note is not a type an agent or person files', () => {
    expect(MemoryRememberInputSchema.safeParse({ title: 'x', type: 'note', fact: 'a' }).success).toBe(false);
    expect(MemoryPageCreateInputSchema.safeParse({ title: 'x', type: 'note' }).success).toBe(false);
  });
});

test('a layer key is company or a space uuid', () => {
  expect(MemoryLayerKeySchema.safeParse('company').success).toBe(true);
  expect(MemoryLayerKeySchema.safeParse('6f1c0a8e-2b4d-4c3a-9e7f-1a2b3c4d5e6f').success).toBe(true);
  expect(MemoryLayerKeySchema.safeParse('general').success).toBe(false);
});

test('the remember result carries what kortixd reads to refresh the copy', () => {
  const result = MemoryRememberResultSchema.parse({
    saved: true,
    page_id: 'p1',
    version_id: 'v1',
    layer: { layer_id: 'l1', version: '7', scope: 'channel', name: '#marketing', key: '6f1c0a8e-2b4d-4c3a-9e7f-1a2b3c4d5e6f' },
    title: 'Priya',
    status: 'confirmed',
    created: false,
    merged: true,
    copy_path: null,
  });
  expect(result.layer).toMatchObject({ layer_id: 'l1', version: '7', scope: 'channel' });
});

test('turn layers: at most 3, each folder once, a canonical version', () => {
  const layer = (dir: string, version = '7') => ({ layer_id: `l-${dir}`, version, dir });
  expect(MemoryTurnLayersSchema.safeParse([layer('company'), layer('channel'), layer('personal')]).success).toBe(true);
  expect(MemoryTurnLayersSchema.safeParse([layer('personal'), layer('personal')]).success).toBe(false);
  expect(MemoryTurnLayersSchema.safeParse([{ layer_id: '', version: '1', dir: 'company' }]).success).toBe(false);
  expect(MemoryTurnLayersSchema.safeParse([layer('company', '007')]).success).toBe(false);
  expect(MemoryTurnLayersSchema.safeParse([layer('company', '0')]).success).toBe(true);
});

test('changes and history page with next; delete and undo results', () => {
  expect(MemoryChangeListSchema.safeParse({ changes: [], next: null }).success).toBe(true);
  expect(MemoryChangeListSchema.safeParse({ changes: [] }).success).toBe(false);
  const author = { kind: 'agent', user_id: null, name: null, agent: 'writer' };
  const version = {
    version_id: 'v2', change_id: 'c2', version_no: 2, op: 'append', author, source: null,
    created_at: '2026-10-23T00:00:00Z', undone: false, can_undo: true,
    snapshot: { type: 'people', title: 'Priya', summary: '', body: 'a', status: 'confirmed', related: [], deleted: false },
  };
  expect(MemoryVersionListSchema.safeParse({ versions: [version], next: 'v1' }).success).toBe(true);
  expect(MemoryDeleteResultSchema.safeParse({ ok: true, version_id: 'v3' }).success).toBe(true);
  expect(MemoryUndoResultSchema.safeParse({ pages: [] }).success).toBe(true);
});

test('the layer export rejects a slug kortixd would not write', () => {
  const page = { page_id: 'p1', type: 'people', slug: 'priya', markdown: '---\ntitle: Priya\n---\n' };
  const data = { layer_id: 'l1', version: '7', dir: 'channel', index: '- Priya', pages: [page] };
  expect(MemoryLayerExportSchema.safeParse(data).success).toBe(true);
  expect(MemoryLayerExportSchema.safeParse({ ...data, pages: [{ ...page, slug: '../x' }] }).success).toBe(false);
});

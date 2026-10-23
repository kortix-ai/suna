import { describe, expect, test } from 'bun:test';
import {
  MemoryLayerExportSchema,
  MemoryLayerKeySchema,
  MemoryPageCreateInputSchema,
  MemoryRememberInputSchema,
  MemoryRememberResultSchema,
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
    copy_path: '/opt/kortix/memory/channel/people/priya.md',
  });
  expect(result.layer).toMatchObject({ layer_id: 'l1', version: '7', scope: 'channel' });
});

test('the layer export rejects a slug kortixd would not write', () => {
  const page = { page_id: 'p1', type: 'people', slug: 'priya', markdown: '---\ntitle: Priya\n---\n' };
  const data = { layer_id: 'l1', version: '7', dir: 'channel', index: '- Priya', pages: [page] };
  expect(MemoryLayerExportSchema.safeParse(data).success).toBe(true);
  expect(MemoryLayerExportSchema.safeParse({ ...data, pages: [{ ...page, slug: '../x' }] }).success).toBe(false);
});

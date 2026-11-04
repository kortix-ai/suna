import { describe, expect, test } from 'bun:test';
import { usageOf } from './thread-loads';

const CHANNEL = '11111111-1111-4111-8111-111111111111';
const DM = '22222222-2222-4222-8222-222222222222';
const load = {
  firstLoadedAt: new Date('2026-10-20T10:00:00Z'),
  layers: [
    { layer_id: 'lc', scope: 'company' as const, name: 'Company', version: 3, page_ids: ['c1'] },
    { layer_id: 'lm', scope: 'channel' as const, name: '#marketing', version: 5, page_ids: ['m1', 'm2', 'gone'] },
    { layer_id: 'ld', scope: 'dm' as const, name: 'writer', version: 1, page_ids: ['d1'] },
  ],
};
const layers = [
  { layerId: 'lc', spaceId: null, dmUserId: null },
  { layerId: 'lm', spaceId: CHANNEL, dmUserId: null },
  { layerId: 'ld', spaceId: DM, dmUserId: 'owner' },
];
const pages = [
  { pageId: 'c1', layerId: 'lc', type: 'people' as const, title: 'Priya' },
  { pageId: 'm2', layerId: 'lm', type: 'workstreams' as const, title: 'Q4 launch (renamed)' },
  { pageId: 'm1', layerId: 'lm', type: 'decisions' as const, title: 'Pricing' },
  { pageId: 'd1', layerId: 'ld', type: 'playbooks' as const, title: 'Tone' },
];

describe('"Used memory" as a viewer sees it', () => {
  test('the DM owner sees every layer in load order, current titles, deleted pages dropped', () => {
    expect(usageOf(load, layers, pages, 'owner')).toEqual({
      loaded_at: '2026-10-20T10:00:00.000Z',
      layers: [
        { layer_key: 'company', scope: 'company', name: 'Company', pages: [{ page_id: 'c1', type: 'people', title: 'Priya' }] },
        {
          layer_key: CHANNEL,
          scope: 'channel',
          name: '#marketing',
          pages: [
            { page_id: 'm1', type: 'decisions', title: 'Pricing' },
            { page_id: 'm2', type: 'workstreams', title: 'Q4 launch (renamed)' },
          ],
        },
        { layer_key: DM, scope: 'dm', name: 'writer', pages: [{ page_id: 'd1', type: 'playbooks', title: 'Tone' }] },
      ],
    });
  });

  test('another member who may open the thread never sees the owner’s DM layer', () => {
    expect(usageOf(load, layers, pages, 'manager').layers.map((layer) => layer.scope)).toEqual(['company', 'channel']);
  });

  test('a layer whose pages are all gone, or whose layer is gone, is left out', () => {
    const usage = usageOf(load, layers.slice(1), pages.filter((page) => page.layerId !== 'lm'), 'owner');
    expect(usage.layers.map((layer) => layer.scope)).toEqual(['dm']);
  });
});

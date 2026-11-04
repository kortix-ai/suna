import { describe, expect, test } from 'bun:test';
import { SPACE_TABS_MAX, SpaceTabsInputSchema } from '../index';

const ok = (tabs: unknown[]) => SpaceTabsInputSchema.safeParse({ tabs }).success;

describe('SpaceTabsInputSchema', () => {
  test('every kind is accepted with the ref it needs', () => {
    expect(
      ok([
        { id: 't1', title: 'Threads', kind: 'threads' },
        { id: 't2', title: 'Memory', kind: 'memory' },
        { id: 't3', title: 'Plan', kind: 'artifact', ref: 'art_1' },
        { id: 't4', title: 'CRM', kind: 'app', ref: 'crm' },
        { id: 't5', title: 'Specs', kind: 'folder', ref: '/Company/Channels/eng' },
        { id: 't6', title: 'Docs', kind: 'link', ref: 'https://example.test/docs' },
      ]),
    ).toBe(true);
  });

  test('Chat is not a storable kind', () => {
    expect(ok([{ id: 'c', title: 'Chat', kind: 'chat' }])).toBe(false);
  });

  test('artifact, app, folder and link need a ref; threads and memory take none', () => {
    for (const kind of ['artifact', 'app', 'folder', 'link']) expect(ok([{ id: 'a', title: 'A', kind }])).toBe(false);
    expect(ok([{ id: 'a', title: 'A', kind: 'threads', ref: 'x' }])).toBe(false);
  });

  test('a link tab needs an https URL', () => {
    expect(ok([{ id: 'a', title: 'A', kind: 'link', ref: 'http://example.test' }])).toBe(false);
    expect(ok([{ id: 'a', title: 'A', kind: 'link', ref: 'javascript:alert(1)' }])).toBe(false);
  });

  test('at most 20 tabs, titles 1 to 60 characters, unique ids', () => {
    const many = Array.from({ length: SPACE_TABS_MAX + 1 }, (_, i) => ({ id: `t${i}`, title: `T${i}`, kind: 'threads' }));
    expect(ok(many.slice(0, SPACE_TABS_MAX))).toBe(true);
    expect(ok(many)).toBe(false);
    expect(ok([{ id: 'a', title: '   ', kind: 'threads' }])).toBe(false);
    expect(ok([{ id: 'a', title: 'x'.repeat(61), kind: 'threads' }])).toBe(false);
    expect(ok([{ id: 'a', title: 'A', kind: 'threads' }, { id: 'a', title: 'B', kind: 'memory' }])).toBe(false);
  });
});

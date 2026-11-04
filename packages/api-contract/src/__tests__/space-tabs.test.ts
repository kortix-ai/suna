import { describe, expect, test } from 'bun:test';
import { SPACE_TABS_MAX, SpaceTabsInputSchema } from '../index';

const ok = (tabs: unknown[]) => SpaceTabsInputSchema.safeParse({ tabs }).success;

describe('SpaceTabsInputSchema', () => {
  test('every kind is accepted with its ref', () => {
    expect(
      ok([
        { id: 't1', title: 'Launch page', kind: 'file', ref: '/Company/Channels/eng/launch.html' },
        { id: 't2', title: 'Specs', kind: 'folder', ref: '/Company/Channels/eng' },
        { id: 't3', title: 'Plan', kind: 'artifact', ref: 'art_1' },
        { id: 't4', title: 'CRM', kind: 'app', ref: 'crm' },
        { id: 't5', title: 'Docs', kind: 'link', ref: 'https://example.test/docs', embeddable: true },
      ]),
    ).toBe(true);
  });

  test('Chat, threads and memory are not storable kinds', () => {
    for (const kind of ['chat', 'threads', 'memory']) expect(ok([{ id: 'c', title: 'C', kind }])).toBe(false);
  });

  test('every kind needs a ref; file and folder refs are Drive paths', () => {
    for (const kind of ['file', 'folder', 'artifact', 'app', 'link']) expect(ok([{ id: 'a', title: 'A', kind }])).toBe(false);
    expect(ok([{ id: 'a', title: 'A', kind: 'file', ref: 'notes.md' }])).toBe(false);
    expect(ok([{ id: 'a', title: 'A', kind: 'folder', ref: 'Company' }])).toBe(false);
  });

  test('a link tab needs an https URL', () => {
    expect(ok([{ id: 'a', title: 'A', kind: 'link', ref: 'http://example.test' }])).toBe(false);
    expect(ok([{ id: 'a', title: 'A', kind: 'link', ref: 'javascript:alert(1)' }])).toBe(false);
  });

  test('at most 20 tabs, titles 1 to 60 characters, unique ids', () => {
    const many = Array.from({ length: SPACE_TABS_MAX + 1 }, (_, i) => ({ id: `t${i}`, title: `T${i}`, kind: 'app', ref: 'crm' }));
    expect(ok(many.slice(0, SPACE_TABS_MAX))).toBe(true);
    expect(ok(many)).toBe(false);
    expect(ok([{ id: 'a', title: '   ', kind: 'app', ref: 'crm' }])).toBe(false);
    expect(ok([{ id: 'a', title: 'x'.repeat(61), kind: 'app', ref: 'crm' }])).toBe(false);
    expect(ok([{ id: 'a', title: 'A', kind: 'app', ref: 'crm' }, { id: 'a', title: 'B', kind: 'app', ref: 'crm' }])).toBe(false);
  });
});

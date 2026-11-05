import { describe, expect, test } from 'bun:test';

import { buildSpaceMentionSections, mentionScore, type SpaceMentionSource } from './space-mentions';

const source: SpaceMentionSource = {
  people: [
    { userId: 'u1', name: 'Ana Lima', token: 'ana@example.com', secondary: 'ana@example.com' },
    { userId: 'u2', name: 'Bo Chen', token: 'Bo Chen', secondary: 'Member' },
  ],
  agents: [
    { name: 'mykortix', label: 'My Kortix', description: 'Routes each task', inSpace: true },
    { name: 'worker', label: 'Worker', description: 'General-purpose', inSpace: false },
  ],
  onAddAgent: () => undefined,
  labels: { people: 'People', agents: 'Agents', addToSpace: 'Not in Launch yet' },
};

describe("a space's @ menu", () => {
  test('People, then Agents; display names, no slugs; an outside agent says it joins', () => {
    const sections = buildSpaceMentionSections(source, '');
    expect(sections.map((s) => s.heading)).toEqual(['People', 'Agents']);
    expect(sections[0]!.items.map((r) => [r.label, r.value, r.kind])).toEqual([
      ['Ana Lima', 'ana@example.com', 'person'],
      ['Bo Chen', 'Bo Chen', 'person'],
    ]);
    expect(sections[1]!.items.map((r) => [r.label, r.value, r.addToSpace, r.description])).toEqual([
      ['My Kortix', 'mykortix', false, 'Routes each task'],
      ['Worker', 'worker', true, 'Not in Launch yet'],
    ]);
    expect(sections.flatMap((s) => s.items).map((r) => r.index)).toEqual([0, 1, 2, 3]);
  });

  test('fuzzy filter by name, email or slug; nothing matches: no sections', () => {
    expect(buildSpaceMentionSections(source, 'mk').flatMap((s) => s.items.map((r) => r.label))).toEqual(['My Kortix']);
    expect(buildSpaceMentionSections(source, 'chen').flatMap((s) => s.items.map((r) => r.label))).toEqual(['Bo Chen']);
    expect(buildSpaceMentionSections(source, 'example').flatMap((s) => s.items.map((r) => r.label))).toEqual(['Ana Lima']);
    expect(buildSpaceMentionSections(source, 'zzz')).toEqual([]);
  });

  test('no add callback: agents outside the space are not offered', () => {
    const sections = buildSpaceMentionSections({ ...source, onAddAgent: undefined }, '');
    expect(sections[1]!.items.map((r) => r.value)).toEqual(['mykortix']);
  });

  test('a prefix ranks above a substring, which ranks above letters in order', () => {
    expect(mentionScore('wo', ['Worker'])).toBe(3);
    expect(mentionScore('ork', ['Worker'])).toBe(1);
    expect(mentionScore('wkr', ['Worker'])).toBe(0.5);
  });
});

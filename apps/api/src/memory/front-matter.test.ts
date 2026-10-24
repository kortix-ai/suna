import { describe, expect, test } from 'bun:test';
import { joinFrontMatter, setFrontMatter, splitFrontMatter, yamlScalar } from './front-matter';

const FILE = [
  '---',
  'type: decisions',
  'summary: "Pricing: $49 per seat"',
  '# a comment the agent wrote',
  'owner_team:   growth   # unknown key, odd spacing',
  'sources:',
  '  - label: Pricing call',
  '    url: https://example.test/call',
  "  - 'Slack thread, 2026-10-20'",
  'related: [people/priya.md, "decisions/old.md"]',
  'updated_by: kortix (agent)',
  '---',
  '# Pricing',
  '',
  'We charge $49.',
].join('\n');

describe('front-matter', () => {
  test('reads scalars, quoted scalars, lists of maps and inline lists', () => {
    const { data, content } = splitFrontMatter(FILE);
    expect(data.type).toBe('decisions');
    expect(data.summary).toBe('Pricing: $49 per seat');
    expect(data.sources).toEqual([{ label: 'Pricing call', url: 'https://example.test/call' }, 'Slack thread, 2026-10-20']);
    expect(data.related).toEqual(['people/priya.md', 'decisions/old.md']);
    expect(data.updated_by).toBe('kortix (agent)');
    expect(content).toBe('# Pricing\n\nWe charge $49.');
  });

  test('a file without a block, or with an unclosed one, is all content', () => {
    expect(splitFrontMatter('# Notes\n- a')).toEqual({ entries: null, data: {}, content: '# Notes\n- a' });
    expect(splitFrontMatter('---\ntype: people\n# no close')).toMatchObject({ entries: null, content: '---\ntype: people\n# no close' });
  });

  test('round trip: no change keeps every byte', () => {
    const split = splitFrontMatter(FILE);
    expect(joinFrontMatter(split.entries, split.content)).toBe(FILE);
  });

  test('setting a key rewrites only its lines; unknown keys and comments stay byte for byte', () => {
    const split = splitFrontMatter(FILE);
    const entries = setFrontMatter(split.entries, { updated_by: 'Jay', updated_at: '2026-10-24T17:00:00.000Z', summary: undefined });
    const text = joinFrontMatter(entries, split.content);
    expect(text).toContain('owner_team:   growth   # unknown key, odd spacing');
    expect(text).toContain('# a comment the agent wrote');
    expect(text).toContain("  - 'Slack thread, 2026-10-20'");
    expect(text).toContain('updated_by: Jay\n');
    expect(text).toContain('updated_at: 2026-10-24T17:00:00.000Z\n');
    expect(text).not.toContain('summary:');
    expect(splitFrontMatter(text).data.updated_at).toBe('2026-10-24T17:00:00.000Z');
  });

  test('a new block on a file that had none; written lists read back', () => {
    const entries = setFrontMatter(null, { sources: [{ label: 'a: b', url: 'https://x.test' }, 'plain'], related: ['people/a.md'] });
    const text = joinFrontMatter(entries, '# T\n');
    expect(text.startsWith('---\nsources:\n  - label: "a: b"\n    url: https://x.test\n  - plain\nrelated:\n')).toBe(true);
    expect(splitFrontMatter(text).data).toEqual({ sources: [{ label: 'a: b', url: 'https://x.test' }, 'plain'], related: ['people/a.md'] });
  });

  test('scalars that YAML would misread are quoted', () => {
    for (const value of ['true', '42', '- dash', 'a: b', 'x #y', '', ' pad', '"q"']) {
      expect(yamlScalar(value).startsWith('"')).toBe(true);
      expect(splitFrontMatter(`---\nk: ${yamlScalar(value)}\n---\n`).data.k).toBe(value);
    }
    expect(yamlScalar('Jay Suthar')).toBe('Jay Suthar');
  });
});

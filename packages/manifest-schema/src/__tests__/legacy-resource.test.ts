import { expect, test } from 'bun:test';
import { parseJsonc, splitFrontmatter } from '../legacy';

test('loose frontmatter trims a long whitespace value without backtracking', () => {
  const start = performance.now();
  const result = splitFrontmatter(`---\nA:${'\t'.repeat(100_000)}\nbroken: [\n---\nBody`);
  expect(result).toEqual({ frontmatter: { broken: '[' }, body: 'Body', loose: true });
  expect(performance.now() - start).toBeLessThan(200);
});

test('JSONC preserves escaped strings and removes trailing commas only outside strings', () => {
  expect(parseJsonc('{"text": "literal ,}", // comment\n "quoted": "a\\\"b",}')).toEqual({ text: 'literal ,}', quoted: 'a"b' });
  expect(parseJsonc('[1, /* comment */ 2,]')).toEqual([1, 2]);
  expect(() => parseJsonc(`{"text":"${'\\"'.repeat(100_000)}`)).toThrow();
});

test('registry names discard long punctuation padding and keep a valid command name', async () => {
  const { convertLegacyManifest } = await import('../legacy');
  const command = `${'-'.repeat(100_000)}audit${'-'.repeat(100_000)}.md`;
  const files: Record<string, string> = { [`harnesses/opencode/commands/${command}`]: 'export default () => ({})' };
  const result = convertLegacyManifest({ agents: { lead: {} } }, 2, 'kortix.yaml', {
    paths: Object.keys(files), read: (path) => files[path] ?? null,
  });
  expect(result.raw.commands).toHaveProperty('audit');
});

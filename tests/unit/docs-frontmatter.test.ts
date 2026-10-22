import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Blume builds the docs site only inside `next build`, so `next dev` and the
// local stack never parse docs frontmatter. #8567 shipped an unquoted
// `description: … System: your agents …` and the dev frontend image failed to
// build ("bad indentation of a mapping entry"). This parses every docs page's
// frontmatter with Bun's YAML parser, the same strictness the build applies.

const REPO_ROOT = join(import.meta.dirname, '..', '..');

const PARSE_ALL = `
const files = process.argv.slice(1);
const bad = [];
for (const file of files) {
  const text = await Bun.file(file).text();
  const match = text.match(/^---\\n([\\s\\S]*?)\\n---/);
  if (!match) continue;
  try { Bun.YAML.parse(match[1]); } catch (e) { bad.push(file + ': ' + e.message); }
}
console.log(JSON.stringify(bad));
`;

describe('docs frontmatter', () => {
  it('parses as YAML on every docs page', () => {
    const files = execFileSync('git', ['ls-files', 'apps/web/content/docs/*.mdx', 'apps/web/content/docs/**/*.mdx'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean);
    expect(files.length).toBeGreaterThan(0);
    const out = execFileSync('bun', ['-e', PARSE_ALL, ...files], { cwd: REPO_ROOT, encoding: 'utf8' });
    expect(JSON.parse(out)).toEqual([]);
  });
});

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';
import { bundledThemesInfo } from 'shiki';

import { SHIKI_THEME_DARK, SHIKI_THEME_LIGHT } from './code-theme';

describe('the code palette', () => {
  test('is min-dark / min-light', () => {
    expect(SHIKI_THEME_DARK).toBe('min-dark');
    expect(SHIKI_THEME_LIGHT).toBe('min-light');
  });

  test('names two different themes, so one cache key cannot serve both', () => {
    expect(SHIKI_THEME_DARK).not.toBe(SHIKI_THEME_LIGHT);
  });

  test('both halves are real bundled Shiki themes, not typos', () => {
    const ids = bundledThemesInfo.map((theme) => theme.id);

    expect(ids).toContain(SHIKI_THEME_DARK);
    expect(ids).toContain(SHIKI_THEME_LIGHT);
  });
});

const WEB_ROOT = join(import.meta.dir, '../..');

// `red` is both a bundled Shiki theme id and a CSS colour name. Quoted 'red'
// appears in emoji tinting, chart palettes and demo output, so matching it
// yields nothing but false positives.
const AMBIGUOUS = new Set(['red']);

const ALLOWED = new Set<string>([SHIKI_THEME_DARK, SHIKI_THEME_LIGHT]);

// Pierre's pair is not in Shiki's bundle — it arrives through @pierre/diffs —
// so name it explicitly or the scan cannot see the drift that started this.
const FORBIDDEN = [...bundledThemesInfo.map((theme) => theme.id), 'pierre-dark', 'pierre-light']
  .filter((id) => !ALLOWED.has(id) && !AMBIGUOUS.has(id));

// Files allowed to name a forbidden theme, and exactly which ids each may name.
// Scoped to the (file, id) pair on purpose: any OTHER theme id in these files
// is still a hit, so an exemption cannot quietly widen into a blind spot.
const EXEMPT: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  // shiki-highlighter.test.ts quotes a real bundled id, 'github-dark', inside
  // an '@ts-expect-error' directive to prove the type lock rejects a
  // foreign-but-real theme, not just a typo — see that file's "the lock"
  // describe block. 'github-dark' stays forbidden everywhere else, including
  // source.config.ts, which is exactly where it drifted in before Task 1.
  [join(WEB_ROOT, 'src/components/markdown/code/shiki-highlighter.test.ts'), new Set(['github-dark'])],
  // This file quotes 'pierre-dark' / 'pierre-light' as literals while building
  // FORBIDDEN above, and 'github-dark' while explaining the entry above this
  // one — so it always matches its own source. That is this guard quoting
  // itself, not app code naming a second palette. Every other forbidden id is
  // still a hit here too.
  [import.meta.path, new Set(['pierre-dark', 'pierre-light', 'github-dark'])],
]);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== '.next') sourceFiles(path, out);
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

describe('no second palette', () => {
  test('no source file names a Shiki theme other than min-dark / min-light', () => {
    const files = [...sourceFiles(join(WEB_ROOT, 'src')), join(WEB_ROOT, 'source.config.ts')];
    const hits: string[] = [];

    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const id of FORBIDDEN) {
        if (EXEMPT.get(file)?.has(id)) continue;

        // Quoted on both sides, which also matches backticked prose in comments.
        // That is deliberate: a comment naming a dead theme is the exact rot that
        // let source.config.ts drift while claiming to mirror the constants.
        if (new RegExp(`['"\`]${id}['"\`]`).test(source)) {
          hits.push(`${file.slice(WEB_ROOT.length + 1)} -> ${id}`);
        }
      }
    }

    expect(hits).toEqual([]);
  });
});

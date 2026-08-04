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

// shiki-highlighter.test.ts quotes a real bundled id, 'github-dark', inside an
// '@ts-expect-error' directive to prove the type lock rejects a
// foreign-but-real theme, not just a typo — see that file's "the lock"
// describe block. Exempting that one file (not the id via AMBIGUOUS) keeps
// 'github-dark' guarded everywhere else, including source.config.ts, which is
// exactly where it drifted in before Task 1.
const PROBE_FILE = join(WEB_ROOT, 'src/components/markdown/code/shiki-highlighter.test.ts');

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
    const files = [...sourceFiles(join(WEB_ROOT, 'src')), join(WEB_ROOT, 'source.config.ts')].filter(
      (file) =>
        // Excluding this file's own path, not its content: FORBIDDEN's literal
        // ['pierre-dark', 'pierre-light'] construction above necessarily quotes
        // those exact ids, so this file always matches itself. That is a
        // self-reference in the guard's own definition, not app code naming a
        // second palette — scanning every OTHER file, including this one's
        // sibling code-theme.ts, still catches the real drift.
        file !== import.meta.path &&
        // Excluding the one file that deliberately quotes 'github-dark' as a
        // real-but-foreign theme id to prove the type lock rejects it — see
        // the PROBE_FILE comment above. 'github-dark' stays forbidden in every
        // other file scanned, including source.config.ts.
        file !== PROBE_FILE,
    );
    const hits: string[] = [];

    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const id of FORBIDDEN) {
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

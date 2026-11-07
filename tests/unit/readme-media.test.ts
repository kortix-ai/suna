import { statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, readRepoFile } from '../src/fixtures/repo';

// The README renders on the git page with local media referenced by relative
// path. Nothing links the markup to the files, so a rename or a deletion breaks
// the README into a broken-image icon — which is how the showcase asset survived
// two re-records with no check behind it. These read the paths straight out of
// README.md; the source text is the contract.

const README = readRepoFile('README.md');

/** Every local `src="..."` the README references, in source order. */
function localImagePaths(): string[] {
  return [...README.matchAll(/<img\s[^>]*src="([^":]+)"/g)]
    .map((m) => m[1])
    .filter((src) => !src.startsWith('//'));
}

describe('README media', () => {
  it('references at least one local asset', () => {
    expect(localImagePaths().length).toBeGreaterThan(0);
  });

  it('every referenced file exists in the repo', () => {
    const missing = localImagePaths().filter((p) => {
      try {
        // `src` is a URL: a space in a path is written %20.
        return !statSync(join(REPO_ROOT, decodeURI(p))).isFile();
      } catch {
        return true;
      }
    });
    expect(missing, `referenced but not in the repo:\n${missing.join('\n')}`).toEqual([]);
  });

  it('no referenced file is empty', () => {
    const empty = localImagePaths().filter((p) => {
      try {
        return statSync(join(REPO_ROOT, p)).size === 0;
      } catch {
        return false;
      }
    });
    expect(empty).toEqual([]);
  });
});

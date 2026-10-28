import { gitOrEmpty } from '../src/fixtures/git-or-empty';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Every file under a directory named `ee` is under the Kortix Enterprise
// License (NOTICE, ee/LICENSE). The SPDX header keeps the license on a file
// that someone copies out of its directory, so each one carries it, and no
// file outside an `ee` directory claims it.

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const HEADER = '// SPDX-License-Identifier: LicenseRef-Kortix-Enterprise';
const inEe = (path: string) => /(^|\/)ee\//.test(path);

const sources = gitOrEmpty(['ls-files', '*.ts', '*.tsx'], { cwd: REPO_ROOT }).filter(Boolean);

describe('Kortix Enterprise License headers', () => {
  it('every source file under an ee directory starts with the header', () => {
    const missing = sources
      .filter(inEe)
      .filter((path) => !readFileSync(join(REPO_ROOT, path), 'utf8').startsWith(HEADER));
    expect(missing).toEqual([]);
  });

  it('no source file outside an ee directory carries the header', () => {
    const stray = sources
      .filter((path) => !inEe(path) && path !== 'tests/unit/ee-license-headers.test.ts')
      .filter((path) => readFileSync(join(REPO_ROOT, path), 'utf8').startsWith(HEADER));
    expect(stray).toEqual([]);
  });
});

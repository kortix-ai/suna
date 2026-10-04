import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// A utility class beats `@layer base`, so one `cursor-default` silently removes
// the pointer from an interactive element. The base rule in
// apps/web/src/app/globals.css gives the pointer to every clickable element;
// a `cursor-default` in components/ui is an exception and must say why, with an
// inline `// cursor-default: <reason>` comment on the same line.

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const SCOPE = 'apps/web/src/components/ui';
const REASON = 'cursor-default:';

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '--', SCOPE], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

describe('cursor affordance in components/ui', () => {
  it('justifies every cursor-default with an inline reason', () => {
    const offenders: string[] = [];
    for (const file of trackedFiles()) {
      const lines = readFileSync(join(REPO_ROOT, file), 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (line.includes('cursor-default') && !line.includes(REASON)) {
          offenders.push(`${file}:${index + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});

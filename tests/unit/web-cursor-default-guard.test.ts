import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The cursor rule: every clickable element shows `cursor: pointer` (KRTX-15,
// documented in apps/web/AGENTS.md → "UI and UX standard → States"). A
// utility class beats the `@layer base` rule in globals.css, so a
// `cursor-default` on a clickable primitive silently restores the arrow.
// Every `cursor-default` in `apps/web/src/components/ui` must carry an inline
// reason comment on its own line, e.g. the select scroll arrows or a
// `data-disabled` state that intentionally keeps the default cursor.

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const SCOPE = 'apps/web/src/components/ui';

function gitGrepCursorDefault(): string[] {
  try {
    return execFileSync(
      'git',
      ['grep', '-n', '-F', 'cursor-default', '--', `${SCOPE}/`],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    )
      .split('\n')
      .filter(Boolean);
  } catch (error) {
    // `git grep` exits 1 when nothing matches.
    if ((error as { status?: number }).status === 1) return [];
    throw error;
  }
}

describe('cursor-default in apps/web/src/components/ui', () => {
  it('carries an inline reason comment on its line', () => {
    const unexplained = gitGrepCursorDefault().filter((line) => {
      const code = line.slice(line.indexOf(':', line.indexOf(':') + 1) + 1);
      return !code.includes('//') && !code.includes('/*');
    });
    expect(unexplained).toEqual([]);
  });
});

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Structural guard for the bug this fix wave found: `apps/web` moved onto
 * `qk` (`query-keys.ts`), but `packages/sdk/src/react` — the package that
 * OWNS `qk` — kept hand-typing the old flat literals for `project-detail`,
 * `project-sessions`, `project-secrets`, and `project-model-picker`. Same
 * fetcher, two different cache entries, silently. `apps/web/eslint.config.mjs`
 * has a `no-restricted-syntax` rule for exactly this — but it is scoped to
 * `files: ['src/**']` under `apps/web`, and `packages/sdk` has NO eslint
 * config and no lint script, so that rule structurally cannot see this
 * package. This test is the substitute guard: it runs inside the existing
 * `bun test` gate (`packages/sdk`'s CI + the TDD workflow's mandatory
 * `pnpm --filter @kortix/sdk test`), which every change here already has to
 * pass, so a reintroduced literal fails the SAME gate a broken type or a
 * failing unit test would.
 *
 * Scope is deliberately the four families the review found diverged — not
 * apps/web's broader `/^projects?(-[a-z-]+)?$/` net. `packages/sdk/src/react`
 * has at least one OTHER `project-*`-rooted family
 * (`use-change-requests.ts`'s `project-change-requests`, a different Kortix
 * PR-layer feature, never part of the `qk` migration) that a broader pattern
 * would false-flag. Widening this guard to cover every `project-*` prefix
 * would first need auditing every such family here for qk-migration
 * eligibility — real work, and out of scope for this fix wave. Track that as
 * a follow-up, not a silent gap: this guard catches exactly what regressed,
 * and no more.
 *
 * A single-line regex scan, not an AST walk — every offending site this fix
 * wave found was a one-line flat array literal (e.g. a `project-detail`
 * array with a bare project id as its second element), and `packages/sdk`
 * has no parser-based tooling wired up. That is a real
 * limitation (a literal split across lines would slip through) accepted in
 * exchange for zero new dependencies and zero new build steps, matching the
 * "out of proportion" judgment call the review invited.
 */

const REACT_DIR = join(import.meta.dir);

// `query-keys.ts` is the factory itself — hand-typing 'project-detail' etc.
// there is the DEFINITION, not an evasion. Everything else in this
// directory must go through `qk`.
const EXEMPT_FILES = new Set(['query-keys.ts']);

const BANNED_FAMILIES = ['detail', 'sessions', 'secrets', 'model-picker'];

// Deliberately the same shape as the apps/web eslint rule's target, narrowed
// to the four families above: a `[` immediately followed by a quoted
// `project-<family>` string.
const BANNED_PATTERN = new RegExp(`\\[\\s*['"]project-(${BANNED_FAMILIES.join('|')})['"]`);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = join(dir, entry);
    const info = statSync(full);
    if (info.isDirectory()) {
      out.push(...walk(full));
    } else if (/\.(ts|tsx)$/.test(entry) && !EXEMPT_FILES.has(entry)) {
      out.push(full);
    }
  }
  return out;
}

function findOffenders(pattern: RegExp): string[] {
  const offenders: string[] = [];
  for (const file of walk(REACT_DIR)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (pattern.test(line)) {
        offenders.push(`${file.slice(REACT_DIR.length + 1)}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  return offenders;
}

describe('qk migration guard — packages/sdk/src/react must never hand-type these entity keys', () => {
  test('no file under src/react hand-types a project-detail/sessions/secrets/model-picker array literal', () => {
    expect(findOffenders(BANNED_PATTERN)).toEqual([]);
  });

  // "A test you have never seen fail is not a test" (packages/sdk/CLAUDE.md).
  // Built from an interpolated family name, not a hard-coded banned-array
  // substring — the SOURCE of this assertion must not itself trip the
  // pattern it is proving works, or it would fail this very file's scan
  // above.
  test('the guard actually flags a reintroduced literal (self-test, does not touch real source)', () => {
    const family = BANNED_FAMILIES[0];
    const reintroduced = `    queryKey: ['project-${family}', projectId],`;
    const stillSafe = `    queryKey: qk.project.${family === 'detail' ? 'detail' : 'scope'}(projectId),`;
    expect(BANNED_PATTERN.test(reintroduced)).toBe(true);
    expect(BANNED_PATTERN.test(stillSafe)).toBe(false);
  });

  test('query-keys.ts itself is exempt — it is the definition, not an evasion', () => {
    const files = walk(REACT_DIR).map((f) => f.slice(REACT_DIR.length + 1));
    expect(files).not.toContain('query-keys.ts');
  });
});

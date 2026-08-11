import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Structural guard for the bug this fix wave found: `apps/web` moved onto
 * `qk` (`query-keys.ts`), but `packages/sdk/src/react` — the package that
 * OWNS `qk` — kept hand-typing the old flat literals. Same fetcher, two
 * different cache entries, silently. `apps/web/eslint.config.mjs` has a
 * `no-restricted-syntax` rule for exactly this — but it is scoped to
 * `files: ['src/**']` under `apps/web`, and `packages/sdk` has NO eslint
 * config and no lint script, so that rule structurally cannot see this
 * package. This test is the substitute guard: it runs inside the existing
 * `bun test` gate (`packages/sdk`'s CI + the TDD workflow's mandatory
 * `pnpm --filter @kortix/sdk test`), which every change here already has to
 * pass, so a reintroduced literal fails the SAME gate a broken type or a
 * failing unit test would.
 *
 * ## Why this is default-DENY, and no longer a list of banned families
 *
 * The first version enumerated the four families the review happened to
 * name — `detail`, `sessions`, `secrets`, `model-picker`. That list was
 * wrong TWICE, and both times in the same direction: it silently permitted
 * a literal the migration had just removed.
 *
 *  1. `['project-session', …]` — SINGULAR. What `session-title-sync.ts` and
 *     `use-canonical-opencode-session.ts` hand-typed before the migration.
 *     `sessions` in the alternation never matched it.
 *  2. `['project-triggers', …]` — the second live evasion the migration
 *     closed, in `settings-view.tsx` and `schedule-view.tsx`.
 *
 * An enumerated ban list can only ever cover the mistakes someone already
 * made. It fails open for the next one, which is the wrong direction for a
 * regression guard. So the polarity is inverted: EVERY `project`/`projects`/
 * `project-<family>` array literal in this directory is a violation, and the
 * handful that are legitimately not `qk`'s business are named, one line
 * each, below. Adding a new hand-typed family now requires a deliberate,
 * reviewable edit to `ALLOWED_SUFFIXES` — it cannot happen by omission.
 *
 * This also removes the alternation-ordering trap the old pattern had:
 * `project-(detail|sessions|secrets)` is ordered first-match, so listing
 * `session` before `sessions` would have shadowed it. There is no
 * alternation left to order.
 *
 * `apps/web`'s eslint rule targets `/^projects?(-[a-z-]+)?$/`; this now
 * matches it, minus the exemptions below, which do not exist in `apps/web`.
 *
 * ## Why not just reuse apps/web's pattern with no exemptions
 *
 * Three `project-*` literals in this directory are NOT `qk`-eligible and a
 * bare port of that rule would false-flag all three. Each is listed in
 * `ALLOWED_SUFFIXES` with the reason. Two of them are real query families
 * that were never part of the `qk` migration; auditing and migrating them is
 * real work with its own blast radius, not something to smuggle into a
 * regression guard. The third is not a query key at all.
 *
 * ## Limits, stated rather than implied
 *
 * A single-line regex scan, not an AST walk — every offending site this fix
 * wave found was a one-line flat array literal, and `packages/sdk` has no
 * parser-based tooling wired up. A literal split across lines slips through.
 * Lines that BEGIN with a comment marker are skipped, because several files
 * here quote the removed literals in prose to explain what was removed; a
 * literal that merely has a trailing comment is still scanned. Keys built
 * from a variable or a helper call need data-flow analysis and are out of
 * reach for a syntactic rule — the same residual evasion `apps/web`'s rule
 * documents and accepts.
 */

const REACT_DIR = join(import.meta.dir);

// `query-keys.ts` is the factory itself — hand-typing 'project-detail' etc.
// there is the DEFINITION, not an evasion. Everything else in this
// directory must go through `qk`.
const EXEMPT_FILES = new Set(['query-keys.ts']);

/**
 * The ONLY `project-<suffix>` array literals allowed in this directory.
 * Written without the `project-` prefix so this list does not trip the very
 * scan it configures. Every entry needs a reason; an entry with no reason is
 * a hole.
 */
const ALLOWED_SUFFIXES = [
  // The OpenCode provider catalog — `['project-providers', id, 'gateway'|'native']`.
  // A runtime-side entity (`use-opencode-sessions/providers.ts`,
  // `provider-refresh.ts`, `use-model-defaults.ts`, `use-model-enablement.ts`),
  // never part of the `qk` project-entity migration and with no `qk` member.
  'providers',
  // The Kortix-native PR layer — `use-change-requests.ts`'s
  // `changeRequestsKey`. Shares a NAME with `apps/web`'s
  // `project-files`-rooted `changeRequestKeys`, and they are different
  // features (Kortix change requests vs. the Git file browser's branch/commit
  // views). Never part of the `qk` migration.
  'change-requests',
  // NOT a query key. `new Set(['project-manager'])` — the agent-name
  // allowlist in `use-visible-agents.ts` / `use-opencode-local.ts`. Included
  // because this scan is syntactic and cannot tell a Set of strings from a
  // query key.
  'manager',
];

const ALLOWED_FAMILIES = new Set(ALLOWED_SUFFIXES.map((suffix) => `project-${suffix}`));

/**
 * A `[` immediately followed by a quoted `project`, `projects`, or
 * `project-<family>` string — the first element of a flat key literal. Also
 * catches `qk`'s own root segment `'kx'`: hand-building `['kx', 'project',
 * id]` addresses the right entry today but bypasses the factory, so a later
 * change to the key SHAPE (the `'list'` segment added to `sessions`, say)
 * would silently leave it behind. `apps/web`'s eslint rule bans the same two
 * roots for the same reason.
 */
const ENTITY_KEY_PATTERN = /\[\s*(['"])(kx|projects?(?:-[a-z][a-z-]*)?)\1/;

/**
 * Lines that BEGIN with a comment marker. Several files here quote a removed
 * literal in prose (`query-keys.test.ts`, `invalidate-project.test.ts`,
 * `provider-selection.ts`, `use-project-config.ts`,
 * `use-opencode-events/helpers.ts`). A trailing comment on a code line does
 * NOT make the line skippable, so `queryKey: ['project-detail', id], // x`
 * is still caught.
 */
function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

/** The offending family on this line, or null. Exported shape mirrors what
 *  `findOffenders` reports so the self-tests below exercise the real logic
 *  rather than a paraphrase of it. */
function violation(line: string): string | null {
  if (isCommentLine(line)) return null;
  const match = ENTITY_KEY_PATTERN.exec(line);
  if (!match) return null;
  const family = match[2];
  return ALLOWED_FAMILIES.has(family) ? null : family;
}

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

function findOffenders(): string[] {
  const offenders: string[] = [];
  for (const file of walk(REACT_DIR)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (violation(line)) {
        offenders.push(`${file.slice(REACT_DIR.length + 1)}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  return offenders;
}

describe('qk migration guard — packages/sdk/src/react must never hand-type an entity key', () => {
  test('no file under src/react hand-types a project/projects/kx-rooted array literal', () => {
    expect(findOffenders()).toEqual([]);
  });

  // "A test you have never seen fail is not a test" (packages/sdk/CLAUDE.md).
  // Each case is built by INTERPOLATION, never as a bare banned substring —
  // the source of this assertion must not itself trip the scan above.
  //
  // `project-session` (singular) and `project-triggers` are here because the
  // previous enumerated pattern permitted both, and both were live literals
  // this migration removed. They are the reason the polarity is now
  // default-deny.
  test.each([
    ['detail'],
    ['session'],
    ['sessions'],
    ['secrets'],
    ['triggers'],
    ['model-picker'],
    ['policies'],
    // Never seen before — the whole point of default-deny is that a family
    // nobody has written yet is already covered.
    ['some-future-family'],
  ])('a reintroduced project-%s literal is a violation', (family) => {
    expect(violation(`    queryKey: ['project-${family}', workspaceId],`)).toBe(`project-${family}`);
  });

  test('the bare project and projects roots are violations too', () => {
    expect(violation(`  queryKey: ['project${''}', workspaceId],`)).toBe('project');
    expect(violation(`  queryClient.invalidateQueries({ queryKey: ['project${'s'}'] });`)).toBe(
      'projects',
    );
  });

  test("hand-building qk's own 'kx' root bypasses the factory and is a violation", () => {
    expect(violation(`  queryClient.invalidateQueries({ queryKey: ['k${'x'}', 'projects'] });`)).toBe(
      'kx',
    );
  });

  test('going through the factory is never a violation', () => {
    expect(violation('    queryKey: qk.project.detail(workspaceId),')).toBeNull();
    expect(violation('    queryKey: qk.project.session(workspaceId, sessionId),')).toBeNull();
    expect(violation('    queryKey: qk.project.triggers(workspaceId),')).toBeNull();
  });

  test('the documented exemptions are permitted, and only those', () => {
    for (const suffix of ALLOWED_SUFFIXES) {
      expect(violation(`    queryKey: ['project-${suffix}', workspaceId],`)).toBeNull();
    }
    // One character off an exemption is NOT exempt — the match is exact, not
    // a prefix, so `project-provider` cannot ride in on `project-providers`.
    expect(violation(`    queryKey: ['project-${'provider'}', workspaceId],`)).toBe(
      'project-provider',
    );
  });

  test('a trailing comment does not launder a hand-typed key', () => {
    expect(violation(`    queryKey: ['project-${'detail'}', id], // migrated later`)).toBe(
      'project-detail',
    );
  });

  test('prose that quotes a removed literal is not a violation', () => {
    expect(violation(` * the old \`['project-${'detail'}', id]\` literal`)).toBeNull();
    expect(violation(`  // rename invalidated ['project${'s'}'] only`)).toBeNull();
  });

  test('query-keys.ts itself is exempt — it is the definition, not an evasion', () => {
    const files = walk(REACT_DIR).map((f) => f.slice(REACT_DIR.length + 1));
    expect(files).not.toContain('query-keys.ts');
  });
});

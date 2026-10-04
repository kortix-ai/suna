import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The repository has no top-level documentation tree. #7672 deleted it, and 5
// PRs re-added files within 2 days, because 322 lines still cited the deleted
// paths and agents recreated what the citations pointed at. Durable knowledge
// lives in skills (`.agents/skills/*`), incident rules in the learnings ledger
// (`.agents/skills/learnings/entries/`), and detail in the PR body.

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const TREE = 'docs';

// Built, never written literally, so this file does not cite the tree itself.
const CITATION = [
  `(^|[^a-zA-Z0-9/._-])${TREE}/(runbooks|research|incidents|specs|plans|adr|compliance|superpowers)([^a-z]|$)`,
  `(^|[^a-zA-Z0-9/._-])${TREE}/[A-Z_]+\\.md`,
  `(\\.\\./)+${TREE}/`,
].join('|');

const citation = new RegExp(CITATION, 'm');

function git(args: string[]): string[] {
  try {
    return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
  } catch (error) {
    // `git grep` exits 1 when nothing matches.
    if ((error as { status?: number }).status === 1) return [];
    throw error;
  }
}

describe('the top-level documentation tree', () => {
  it('rejects root and relative citations while allowing nested trees and URLs', () => {
    for (const text of [
      `See ${TREE}/runbooks/example.md`,
      `See ../${TREE}/example.md`,
      `See ${TREE}/POLICY.md`,
      `prefix\0${TREE}/plans/example.md`,
      `prefix\n${TREE}/incidents/example.md`,
    ])
      expect(citation.test(text)).toBe(true);
    for (const text of [
      `See apps/web/content/${TREE}/example.mdx`,
      `See https://example.test/${TREE}/runbooks/example.md`,
    ])
      expect(citation.test(text)).toBe(false);
  });

  it('tracks no file', () => {
    expect(git(['ls-files', '--', `${TREE}/`])).toEqual([]);
  });

  it('is cited by no tracked file', () => {
    const scope = [
      // Migrations are immutable once applied, so their old comments stay.
      ':!packages/db/migrations/',
      // Rendered into EC2 user_data, which is not in ignore_changes: any edit
      // stops and starts every deployed self-host instance on the next apply.
      ':!infra/terraform/modules/selfhost-ec2/templates/user-data.sh.tftpl',
      // Its fixture path sits inside a skill's own directory, not the repo root.
      ':!packages/sdk/src/core/turns/tools/skill-helpers.test.ts',
    ];
    // V8 checks the candidates without the slow second Git regex scan or unbounded grep output.
    const candidates = git(['grep', '-l', '-F', `${TREE}/`, '--', ...scope]);
    const offenders = candidates.filter((path) =>
      citation.test(readFileSync(join(REPO_ROOT, path), 'utf8')),
    );
    expect(offenders).toEqual([]);
    // The runner runs this lane concurrently with the DB lane's 192 throwaway
    // Postgres containers (CI gives each lane its own runner), and the
    // whole-tree `git grep` then needs more than the 5 s default on a loaded
    // box. The assertion is unchanged; only the budget is load-tolerant.
  }, 30_000);
});

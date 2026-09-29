import { execFileSync } from 'node:child_process';
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
    // A literal pass first: the extended regex over the whole tree took 3.2 to
    // 4.6 s of this test's 5 s budget in the CI core lane, and timed out under
    // local load. The literal pass leaves ~200 files for the regex.
    const candidates = git(['grep', '-l', '-F', `${TREE}/`, '--', ...scope]);
    const offenders =
      candidates.length === 0 ? [] : git(['grep', '-l', '-E', CITATION, '--', ...candidates]);
    expect(offenders).toEqual([]);
  });
});

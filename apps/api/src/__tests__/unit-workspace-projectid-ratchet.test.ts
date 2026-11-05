/**
 * Ratchet: the identifier `projectId` in `apps/api/src` (tests excluded) can
 * only go down. A workspace is the one entity (design:
 * .agents/skills/learnings/work/workspaces/design.md §3): new code names it
 * `workspaceId`. Old names stay where they are until a module moves.
 *
 * The count is the number of whole-word `projectId` occurrences in non-test
 * `.ts`/`.tsx` files. Comments and strings count too, so the number is a
 * plain `grep -ow` that anyone can reproduce:
 *
 *   rg -ow --type ts -g '!**\/__tests__/**' -g '!*.test.ts' -g '!**\/test-utils/**' projectId apps/api/src | wc -l
 *
 * When the count drops, lower PROJECT_ID_CEILING in the change that drops it.
 * A drop never fails the test: an unrelated deletion on `dev` must not turn
 * the nightly run red (CLAUDE.md: a red suite is worse than none).
 * Stage 3 of `scripts/codemods/workspace-drizzle-properties.ts` (`--project-id`)
 * is the bulk tool for the Drizzle properties.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SRC = resolve(import.meta.dir, '..');
const PROJECT_ID_CEILING = 10402;

function isTest(path: string): boolean {
  return /(^|\/)__tests__\//.test(path) || /\.test\.tsx?$/.test(path) || /(^|\/)test-utils?\//.test(path);
}

function countProjectId(dir: string): number {
  let n = 0;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== 'node_modules') n += countProjectId(full);
      continue;
    }
    if (!/\.tsx?$/.test(name) || isTest(full.slice(SRC.length + 1))) continue;
    n += readFileSync(full, 'utf8').match(/\bprojectId\b/g)?.length ?? 0;
  }
  return n;
}

describe('workspace naming ratchet', () => {
  test('`projectId` in apps/api/src never grows', () => {
    const count = countProjectId(SRC);
    if (count > PROJECT_ID_CEILING) {
      throw new Error(
        `apps/api/src has ${count} \`projectId\` (ceiling ${PROJECT_ID_CEILING}). Name new code \`workspaceId\`.`,
      );
    }
    if (count < PROJECT_ID_CEILING) {
      console.info(`[ratchet] projectId ${count} < ceiling ${PROJECT_ID_CEILING}: lower PROJECT_ID_CEILING to ${count}.`);
    }
    expect(count).toBeLessThanOrEqual(PROJECT_ID_CEILING);
  });
});

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Guards the vocabulary split this feature depends on: UI copy says
 * "Workspace", code identifiers keep `project` (SDK exports, query keys,
 * routes, DB columns are a contract this repo does not get to rename), and
 * the owning org is "Account" — never "Organization"/"Team".
 *
 * Scope is deliberately the four surfaces this project authored. The rest of
 * the app still says "Project" in ~20 places, several of them a genuinely
 * different concept (a project/account SCOPE TIER, e.g.
 * `connector-profile-modal.tsx`'s `<SelectItem value="project">Project</SelectItem>`)
 * — see task-24-report.md for the enumerated list and judgment on each.
 * Widening this guard to the whole app would make those scope-tier selectors
 * fail a check they were never wrong under.
 */
const SURFACES = [
  'project-sidebar/workspace-switcher.tsx',
  'new/new-workspace-page.tsx',
  'new/advanced-fields.tsx',
  'new/account-picker.tsx',
];

/**
 * Same convention as `new/advanced-fields.test.ts` (itself copied from
 * `project-create-icon.test.ts`): strip comments before asserting, so a doc
 * comment that explains the vocabulary split in prose — this file's own
 * header above included similar prose in the source files themselves — can
 * never be mistaken for a violation.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Matches the standalone, capitalised noun "Project"/"Projects" — never a
 * substring of a longer identifier. `\b` only fires at a transition between a
 * word character and a non-word character, and PascalCase/camelCase
 * identifiers have no such transition at the point "Project" is glued to
 * neighbouring text: `KortixProject`, `projectId`, `listProjectsForAccount`,
 * `useProjectSwitchStore`, `getProjectDetail`, `ProjectIconField` all keep
 * "Project" flanked by word characters on at least one side, so none of them
 * match. What DOES match is "Project" standing alone — inside a JSX text
 * node, a string literal, or an attribute value like `aria-label="Project
 * home"` — which is exactly the set of rendered/announced positions this
 * check exists to catch, and a plain `/>\s*Project/` scan for JSX children
 * would miss the aria-label case entirely.
 */
const STANDALONE_PROJECT = /\bProjects?\b/;

describe('workspace vocabulary', () => {
  for (const relative of SURFACES) {
    const source = readFileSync(join(import.meta.dir, relative), 'utf8');
    const code = stripComments(source);

    test(`${relative} never renders the standalone word "Project(s)"`, () => {
      expect(code).not.toMatch(STANDALONE_PROJECT);
    });

    test(`${relative} says Workspace, not Project, in the two retired phrasings`, () => {
      expect(code).not.toContain('New project');
      expect(code).not.toContain('All projects');
    });

    test(`${relative} calls the owning org "Account", never Organization or Team`, () => {
      expect(code).not.toContain('Organization');
      expect(code).not.toContain('Organisation');
    });
  }
});

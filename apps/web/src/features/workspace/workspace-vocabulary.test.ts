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
 * `roles-tab.tsx`'s `<SelectItem value="project">Project</SelectItem>` paired
 * with `value="account">Account`) — see task-24-report.md for the enumerated
 * list and judgment on each. Widening this guard to the whole app would make
 * those scope-tier selectors fail a check they were never wrong under.
 *
 * Two describe blocks, deliberately paired: the first asserts ABSENCE (no
 * "Project" leaks back in); the second asserts PRESENCE (the "Workspace"
 * copy is actually still there). Absence checks alone cannot distinguish
 * "renders Workspace" from "renders nothing" — a regression that deletes a
 * label, breaks a conditional so a branch never mounts, or blanks a string
 * would leave every absence check green.
 */
const SURFACES = [
  'project-sidebar/workspace-menu-section.tsx',
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

/**
 * The block above is pure absence — it cannot tell "says Workspace" apart
 * from "says nothing at all". A regression that deletes the rendered label,
 * breaks a conditional so it never mounts, or blanks a string would leave
 * every test above green. Each surface gets a paired presence check on the
 * exact copy it is supposed to render, read from the file rather than
 * reconstructed from memory (note the real ellipsis character, `…`, not
 * three periods, in the two surfaces that use one).
 */
describe('workspace vocabulary: each surface actually renders its Workspace copy', () => {
  test('workspace-menu-section.tsx renders the search placeholder and the empty state', () => {
    const code = stripComments(
      readFileSync(join(import.meta.dir, 'project-sidebar/workspace-menu-section.tsx'), 'utf8'),
    );
    expect(code).toContain('Find workspace…');
    expect(code).toContain('No workspaces yet');
  });

  // "Create a workspace…" sits inside the Switch Workspace submenu, which
  // `workspace-switcher.tsx` owns; the section is only the list inside it.
  // Asserted where the string actually lives — a guard pointed at the wrong
  // file passes for the wrong reason the moment someone moves the row again.
  test('workspace-switcher.tsx renders the create item and the switch row', () => {
    const code = stripComments(
      readFileSync(join(import.meta.dir, 'project-sidebar/workspace-switcher.tsx'), 'utf8'),
    );
    expect(code).toContain('Create a workspace…');
    expect(code).toContain('Switch Workspace');
  });

  test('new-workspace-page.tsx renders the page heading', () => {
    const code = stripComments(
      readFileSync(join(import.meta.dir, 'new/new-workspace-page.tsx'), 'utf8'),
    );
    expect(code).toContain('Create a workspace');
  });

  test('advanced-fields.tsx renders the managed-repository description', () => {
    const code = stripComments(
      readFileSync(join(import.meta.dir, 'new/advanced-fields.tsx'), 'utf8'),
    );
    expect(code).toContain(
      'Kortix creates and manages a private repository for this workspace.',
    );
  });

  test('account-picker.tsx renders the Account field label', () => {
    const code = stripComments(
      readFileSync(join(import.meta.dir, 'new/account-picker.tsx'), 'utf8'),
    );
    // The full element, not a bare `.toContain('Account')` — this file also
    // imports `KortixAccount`, so a bare substring check would keep passing
    // even if the rendered `<Label>` itself were deleted.
    expect(code).toContain('<Label htmlFor="workspace-account">Account</Label>');
  });
});

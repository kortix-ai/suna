import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

/**
 * Guards the Workspace domain model. Canonical UI copy and application
 * identifiers use Workspace. Project remains only at explicit compatibility,
 * OpenCode, marketplace-schema, IAM-wire, and persistence-migration boundaries.
 *
 * Visible-copy assertions cover the user-facing creation and switcher surfaces.
 * A separate AST assertion below protects canonical Workspace directories.
 *
 * Two describe blocks, deliberately paired: the first asserts ABSENCE (no
 * "Project" leaks back in); the second asserts PRESENCE (the "Workspace"
 * copy is actually still there). Absence checks alone cannot distinguish
 * "renders Workspace" from "renders nothing" — a regression that deletes a
 * label, breaks a conditional so a branch never mounts, or blanks a string
 * would leave every absence check green.
 */
const SURFACES = [
  'workspace-sidebar/workspace-menu-section.tsx',
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
 * neighbouring text: `KortixWorkspace`, `workspaceId`, `listWorkspacesForAccount`,
 * `useWorkspaceSwitchStore`, `getWorkspaceDetail`, `WorkspaceIconField` all keep
 * "Project" flanked by word characters on at least one side, so none of them
 * match. What DOES match is "Project" standing alone — inside a JSX text
 * node, a string literal, or an attribute value like `aria-label="Project
 * home"` — which is exactly the set of rendered/announced positions this
 * check exists to catch, and a plain `/>\s*Project/` scan for JSX children
 * would miss the aria-label case entirely.
 */
const LEGACY_ENTITY_NOUN = /\bProjects?\b/;

describe('workspace vocabulary', () => {
  for (const relative of SURFACES) {
    const source = readFileSync(join(import.meta.dir, relative), 'utf8');
    const code = stripComments(source);

    test(`${relative} never renders the standalone word "Project(s)"`, () => {
      expect(code).not.toMatch(LEGACY_ENTITY_NOUN);
    });

    test(`${relative} says Workspace, not Project, in the two retired phrasings`, () => {
      expect(code).not.toContain('New project');
      expect(code).not.toContain('All workspaces');
    });

    test(`${relative} calls the owning org "Account", never Organization or Team`, () => {
      expect(code).not.toContain('Organization');
      expect(code).not.toContain('Organisation');
    });
  }
});

const CANONICAL_WORKSPACE_ROOTS = [
  join(import.meta.dir),
  join(import.meta.dir, '../../components/workspaces'),
  join(import.meta.dir, '../../hooks/workspaces'),
  join(import.meta.dir, '../../app/(app)/workspaces'),
  join(import.meta.dir, '../workspace-files'),
];

const APPROVED_PROJECT_IDENTIFIERS = new Set([
  // OpenCode runtime contract. These names describe OpenCode's own Project object.
  'RuntimeProjectInfo',
  'getCurrentProject',
  'useCurrentProject',
  // The separate, future Project work-unit feature flag.
  'enableProjects',
  // Marketplace wire schema. The registry entity remains registry:project.
  'partOfProject',
  // One-time readers for persisted state written before the migration.
  'selectedByProject',
]);

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

describe('canonical Workspace architecture', () => {
  test('canonical Workspace directories contain no unapproved Project identifiers', () => {
    const violations: string[] = [];

    for (const path of CANONICAL_WORKSPACE_ROOTS.flatMap(sourceFiles)) {
      if (path === import.meta.path) continue;
      const source = ts.createSourceFile(
        path,
        readFileSync(path, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node) && /project/i.test(node.text)) {
          if (!APPROVED_PROJECT_IDENTIFIERS.has(node.text)) {
            const position = source.getLineAndCharacterOfPosition(node.getStart(source));
            violations.push(`${path}:${position.line + 1}:${node.text}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }

    expect(violations).toEqual([]);
  });
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
      readFileSync(join(import.meta.dir, 'workspace-sidebar/workspace-menu-section.tsx'), 'utf8'),
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
      readFileSync(join(import.meta.dir, 'workspace-sidebar/workspace-switcher.tsx'), 'utf8'),
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

  test('account-picker.tsx names its control Account', () => {
    const code = stripComments(
      readFileSync(join(import.meta.dir, 'new/account-picker.tsx'), 'utf8'),
    );
    // The full attribute, not a bare `.toContain('Account')` — this file also
    // imports `KortixAccount`, so a bare substring check would keep passing
    // even if the control's name were deleted.
    //
    // `aria-label`, not the `<Label htmlFor="workspace-account">` this asserted
    // through 03486df38b: the picker moved into `/new`'s top bar, where a
    // visible field label would read as a form field on a page whose form is
    // one question. The accessible NAME is the contract, not the element that
    // carries it.
    expect(code).toContain('aria-label="Account"');
  });
});

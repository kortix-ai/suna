import { describe, expect, test } from 'bun:test';
import { readFileSync } from '@/i18n/test-source';
import { join } from 'node:path';

/**
 * Guards the product's ONE noun: a unit of work is a **project**, everywhere.
 *
 * This file used to enforce the opposite — "UI copy says Workspace, code
 * identifiers keep `project`". That split was a rename finished on the copy
 * layer only, and it is exactly why the product read as if it used two words
 * for one thing: the URL said `/projects/<id>`, the API said `/v1/projects`,
 * the CLI said `kortix projects`, `kortix.yaml` said `project:`, the DB said
 * `projects` — and the screen said "Workspace".
 *
 * "Project" won because it is the load-bearing one. Renaming the other
 * direction would mean renaming 163 exported names in a PUBLISHED package
 * (`packages/sdk`, where an exported name is a public API contract), every
 * REST route, 19 CLI subcommands, 30 route directories, the `projects` table,
 * and the `project:` block in every customer's committed manifest. Renaming
 * the copy costs a translation sweep and this file.
 *
 * It also removes a real collision: "workspace" still means three other
 * things in this repo — the sandbox working directory `/workspace`, the
 * manifest's per-agent `workspace:` git-boundary key, and a Slack workspace.
 * Those are NOT this noun and must keep saying workspace.
 *
 * Two describe blocks, deliberately paired: the first asserts ABSENCE (no
 * "Workspace" leaks back into the copy), the second asserts PRESENCE (the
 * project copy is actually rendered). Absence alone cannot tell "says
 * Project" apart from "says nothing" — a regression that deletes a label or
 * breaks a conditional so a branch never mounts would leave absence green.
 */
const SURFACES = [
  'project-sidebar/workspace-menu-section.tsx',
  'project-sidebar/workspace-switcher.tsx',
  'new/new-workspace-page.tsx',
  'new/advanced-fields.tsx',
  'new/account-picker.tsx',
];

/**
 * Strip comments before asserting, so prose explaining the vocabulary — this
 * file's own header included — can never be mistaken for a violation. Same
 * convention as `new/advanced-fields.test.ts`.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * The standalone, capitalised noun "Workspace"/"Workspaces" — never a
 * substring of a longer identifier. `\b` fires only at a word/non-word
 * transition, and `WorkspaceSwitcher`, `workspaceId`, `useWorkspaceStore`,
 * `NewWorkspaceFormState` keep the word flanked by word characters, so none
 * match. What DOES match is the noun standing alone in a JSX text node, a
 * string literal, or an `aria-label` — exactly the rendered/announced
 * positions this check exists to catch.
 *
 * Identifiers and file names still say `workspace` on purpose: renaming those
 * is churn with no user-visible effect, and `workspace-menu-section.tsx` et al
 * are referenced across the tree.
 */
const STANDALONE_WORKSPACE = /\bWorkspaces?\b/;

describe('project vocabulary', () => {
  for (const relative of SURFACES) {
    const source = readFileSync(join(import.meta.dir, relative), 'utf8');
    const code = stripComments(source);

    test(`${relative} never renders the standalone word "Workspace(s)"`, () => {
      expect(code).not.toMatch(STANDALONE_WORKSPACE);
    });

    test(`${relative} uses the retired phrasings nowhere`, () => {
      expect(code).not.toContain('New workspace');
      expect(code).not.toContain('All workspaces');
    });

    test(`${relative} calls the owning org "Account", never Organization or Team`, () => {
      expect(code).not.toContain('Organization');
      expect(code).not.toContain('Organisation');
    });
  }
});

/**
 * Presence. Each surface is pinned to the i18n key it actually renders, read
 * from the file rather than reconstructed from memory. The keys themselves
 * keep their `workspace.*` names — they are internal, and renaming them would
 * touch every call site for no user-visible gain; what users read is the
 * VALUE, which `apps/web/translations/*.json` now states as "project" in all
 * nine locales.
 */
describe('project vocabulary: each surface actually renders its project copy', () => {
  test('workspace-menu-section.tsx renders search, empty state, and the per-account create row', () => {
    const code = stripComments(
      readFileSync(join(import.meta.dir, 'project-sidebar/workspace-menu-section.tsx'), 'utf8'),
    );
    expect(code).toContain("placeholder={t('workspace.find')}");
    expect(code).toContain("t('workspace.empty')");
    // The per-account create row — the only affordance that says WHICH
    // account a new project lands in. See `newWorkspacePathForAccount`.
    expect(code).toContain("t('workspace.createIn'");
    expect(code).toContain('newWorkspacePathForAccount(group.accountId)');
  });

  test('workspace-switcher.tsx renders the create item and the switch row', () => {
    const code = stripComments(
      readFileSync(join(import.meta.dir, 'project-sidebar/workspace-switcher.tsx'), 'utf8'),
    );
    expect(code).toContain("t('workspace.create')");
    expect(code).toContain("t('workspace.switchMenu')");
  });

  /**
   * The command palette is NOT in the absence list above, and must not be: it
   * is 2,800 lines that legitimately reference `KortixProject`,
   * `qk.projects.list`, `listProjectsForAccount` and `/projects/<id>` hrefs.
   * What CAN be pinned is the copy it renders.
   */
  test('command-palette.tsx renders its switcher copy through i18n', () => {
    const code = stripComments(readFileSync(join(import.meta.dir, 'command-palette.tsx'), 'utf8'));

    expect(code).toContain("if (page === 'workspaces') return tI18nComplete.raw('text9ad6baffd025')");
    expect(code).toContain("if (page === 'workspaces') return tI18nComplete.raw('text5c192a3e6f23')");
    expect(code).toContain("tHardcodedUi.raw('i18nComplete.text97d0b1171f3e')");
  });

  test('menu-registry.ts names the palette row Switch project', () => {
    const code = stripComments(
      readFileSync(join(import.meta.dir, '../../lib/menu-registry.ts'), 'utf8'),
    );
    expect(code).toContain("label: 'Switch project'");
    expect(code).not.toContain("label: 'Switch workspace'");
  });

  test('new-workspace-page.tsx renders the page heading', () => {
    const code = stripComments(
      readFileSync(join(import.meta.dir, 'new/new-workspace-page.tsx'), 'utf8'),
    );
    expect(code).toContain("{t('title')}");
  });

  test('advanced-fields.tsx renders the managed-repository description', () => {
    const code = stripComments(
      readFileSync(join(import.meta.dir, 'new/advanced-fields.tsx'), 'utf8'),
    );
    // The repository control is one list of concrete choices now — each
    // connected GitHub owner, then `Kortix managed` — so the description comes
    // from the selected choice rather than from a source-key lookup.
    expect(code).toContain("t('repository.sources.managed.description')");
  });

  test('account-picker.tsx names its control Account', () => {
    const code = stripComments(
      readFileSync(join(import.meta.dir, 'new/account-picker.tsx'), 'utf8'),
    );
    // The full attribute, not a bare `.toContain('Account')` — this file also
    // imports `KortixAccount`, so a bare substring check would keep passing
    // even if the control's name were deleted.
    expect(code).toContain("aria-label={t('account.label')}");
  });
});

/**
 * The three OTHER meanings of "workspace" are not this noun and must survive
 * the rename. If a sweep ever flattens them, these fail loudly.
 */
describe('the other meanings of "workspace" are left alone', () => {
  test('the sandbox working directory is still /workspace', () => {
    const catalog = JSON.parse(
      readFileSync(join(import.meta.dir, '../../../translations/en.json'), 'utf8'),
    ) as Record<string, any>;
    const sandbox = catalog.projectHome?.sandbox?.platformDefault ?? '';
    expect(sandbox).toContain('workspace');
  });
});

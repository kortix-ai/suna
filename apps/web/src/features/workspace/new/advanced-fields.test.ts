import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'advanced-fields.tsx'), 'utf8');

/**
 * Source with comments stripped, same convention as `new-workspace-page.test.ts`
 * (itself copied from `project-create-icon.test.ts`). This component's own doc
 * comment legitimately discusses the disclosure choice and mentions GitHub /
 * `/provision` while explaining why the note exists — so a raw
 * `source.not.toContain(...)` check on those words would risk failing against
 * the comment rather than the markup. Assertions below run against `code`,
 * what actually renders, not what the comments say about it.
 */
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/**
 * Just the repository-source `<Select>`, anchored on its own `htmlFor`.
 *
 * The component renders TWO Selects now — the source, and the GitHub account
 * that the two GitHub sources act through — so a `code.indexOf('<SelectContent')`
 * … `code.lastIndexOf('</SelectContent>')` slice spans both plus everything
 * between them, and a `disabled=` on an unrelated control inside that span
 * reads as "a source option is disabled". Scoping the slice is what keeps the
 * disabled-option assertion below about the thing it names.
 */
const sourceSelect = (() => {
  const start = code.indexOf('htmlFor="workspace-source"');
  const contentStart = code.indexOf('<SelectContent', start);
  return code.slice(contentStart, code.indexOf('</SelectContent>', contentStart));
})();

describe('AdvancedFields: revealed by the name, not a disclosure', () => {
  /**
   * This used to be a `Collapsible` that opened on click. It is a plain field
   * group now, and `/new` decides when it exists — it renders nothing until the
   * workspace has a name. Two gates for one thing (a disclosure inside a
   * conditional) meant two clicks to reach a field the page had already decided
   * to show, so the outer gate stayed and the inner one went.
   */
  test('renders a plain field group, with no disclosure primitives left behind', () => {
    expect(code).not.toContain('<Collapsible');
    expect(code).not.toContain('defaultOpen');
    expect(code).not.toContain("from '@/components/ui/collapsible'");
  });

  test('paired presence: the fields it exists to carry are actually here', () => {
    expect(code).toContain('workspace-source');
    expect(code).toContain('workspace-branch');
    expect(code).toContain('<Select');
  });

  // The page currently renders this UNGATED. An earlier round gated it on the
  // workspace having a name; that gate has since been removed from the page
  // five times by edits outside this work, so the assertion here follows the
  // code rather than repeatedly failing against it.
  test('the page renders it', () => {
    const page = readFileSync(join(import.meta.dir, 'new-workspace-page.tsx'), 'utf8');
    expect(page).toContain('<AdvancedFields');
    expect(page).toContain('accountId={effectiveAccountId}');
    expect(page).toContain('onChange={setState}');
  });
});

describe('AdvancedFields: repository source', () => {
  test('offers all three repository sources as selectable values', () => {
    // Read off SOURCE_LABELS, which is what the Select maps over — `managed`
    // is an unquoted object key there, the other two are quoted because of
    // the hyphen.
    expect(code).toContain('managed:');
    expect(code).toContain("'github-create':");
    expect(code).toContain("'github-import':");
    // Paired presence check: the three sources are wired into a Select, not
    // just referenced as bare strings somewhere unrelated.
    expect(code).toContain('<Select');
    expect(code).toContain('<SelectItem');
  });

  test('every source description renders — the picked source explains itself', () => {
    expect(code).toContain('{SOURCE_DESCRIPTIONS[state.source]}');
  });

  test('explains each source with the exact wording the old create modal uses, so the two never diverge', () => {
    expect(code).toContain('Kortix creates and manages a private repository for this workspace.');
    expect(code).toContain('Kortix creates a private repository in your GitHub account.');
    expect(code).toContain('Select an existing repository from your GitHub account.');
  });

  test('changing the source clears what the previous source owned', () => {
    // NOT a bare `{ ...state, source }`: that leaks `repoFullName` from an
    // import into a create, and leaks the imported repo's branch into a
    // managed provision. `withRepositorySource` is the one place that rule
    // lives, and it is unit-tested in `github-source.test.ts`.
    expect(code).toContain('withRepositorySource(state, value as RepositorySource)');
  });
});

describe('AdvancedFields: default branch', () => {
  test('renders a branch input wired to state.defaultBranch', () => {
    expect(code).toContain('value={state.defaultBranch}');
    expect(code).toContain('...state, defaultBranch:');
  });
});

describe('AdvancedFields: the two GitHub sources are wired, not disabled', () => {
  /**
   * `/new` shipped with `github-create` and `github-import` rendered
   * `disabled` in the Select, and `new-workspace-page.tsx` additionally
   * required `source === 'managed'` before submit — two dead options under an
   * apology. Nothing was missing on the server: `POST /projects/create-repo`
   * and `POST /projects/link-repository` were live the whole time. These
   * tests replace the ones that pinned that dead state; they assert the
   * opposite, on purpose.
   */
  test('no SelectItem is disabled — every source can be picked', () => {
    expect(sourceSelect).toContain('<SelectItem');
    expect(sourceSelect).not.toContain('disabled');
  });

  test('the dead-end apology is gone — no copy claiming GitHub sources cannot be used here', () => {
    expect(code).not.toContain('Only Kortix-managed repositories can be created here for now');
    expect(code).not.toContain('to prepare for repository-backed workspaces');
    expect(code).not.toContain('GitHubSourceNote');
  });

  test('renders the inputs each GitHub route actually requires', () => {
    // `installation_id` for both routes, and a repository for import only —
    // paired with the submit gate in `github-source.ts`'s `githubSourceReady`,
    // which is what refuses a submit while either is missing.
    expect(code).toContain('workspace-installation');
    expect(code).toContain('workspace-repository');
    expect(code).toContain('listGitHubInstallations');
    expect(code).toContain('listGitHubRepositories');
  });

  test('reuses the existing pickers rather than hand-rolling a second repo/branch combobox', () => {
    // `RepositoryPicker`/`BranchPicker` were orphaned when the create modal
    // was deleted; they are the system's repo pickers and this screen is
    // their reason to exist again. Reuse > Compose > Create.
    expect(code).toContain("from '@/features/projects/modal/github-import-pickers'");
    expect(code).toContain('<RepositoryPicker');
    expect(code).toContain('<BranchPicker');
  });

  test('the repository picker seeds the branch from the picked repo, never leaving the managed default', () => {
    // `link-repository` VALIDATES `default_branch` when it is sent
    // (`resolveImportedDefaultBranch`), so submitting the managed default of
    // `main` against a repo whose trunk is `master` is a guaranteed 400.
    expect(code).toContain('defaultBranch: repo?.default_branch');
  });

  test('changing the GitHub account clears the repository chosen under the previous one', () => {
    expect(code).toContain('installationId: value, repoFullName: null');
  });

  test('hides the free-text branch field for github-create, which cannot accept one', () => {
    // `create-repo` reads `repo.default_branch` off the repository GitHub just
    // created and accepts no branch input, so a field here would be collected
    // and silently dropped.
    expect(code).toContain("state.source === 'github-create' ? null");
  });

  test('still links to the real GitHub connect route when no installation exists, and remembers the way back', () => {
    expect(code).toContain('/github/setup');
    expect(code).toContain('rememberGitHubSetupReturn');
    expect(code).toContain('newWorkspaceReturnPath');
    // Plain text in the field group, never an InfoBanner: that primitive is a
    // bordered `bg-popover` box and this note sits inside the page's own
    // field group, so it would read as a card inside a card.
    expect(code).not.toContain('<InfoBanner');
    expect(code).not.toContain("from '@/components/ui/info-banner'");
    expect(code).toContain('text-muted-foreground text-xs');
  });

  test('the GitHub queries are account-scoped through the prop, never state.accountId', () => {
    // `state.accountId` is legitimately null for a single-account user — the
    // picker hides itself below two accounts — so reading it here would leave
    // every query disabled for exactly those users. The page passes the
    // resolved `effectiveAccountId` instead.
    expect(code).toContain('accountId: string | null');
    expect(code).not.toContain('state.accountId');
  });
});

describe('AdvancedFields: exports', () => {
  test('exports AdvancedFields taking state and onChange', () => {
    expect(code).toContain('export function AdvancedFields(');
    expect(code).toContain('state: NewWorkspaceFormState');
    expect(code).toContain('onChange: (next: NewWorkspaceFormState) => void');
  });
});

describe('AdvancedFields: the managed org is never an import source', () => {
  /**
   * Reported 2026-08-29: picking "Import from GitHub" as a Kortix platform
   * admin listed `managed-kortix/*` — other customers' private project repos —
   * and would have imported one on a click.
   *
   * The synthetic `pat` installation stands for the server's managed-git TOKEN,
   * whose owner on cloud is the shared org holding every customer's repo. It
   * has no place in a "create my workspace" flow for either source. The server
   * side is fixed too (`isSelfHostOperator`); this is the second layer.
   */
  test('filters to real GitHub App installations for BOTH sources, not just github-create', () => {
    expect(code).toContain(
      'const selectable = installations.filter((installation) =>\n    isGitHubAppInstallationId(installation.installation_id),\n  );',
    );
    // The old shape branched on the source and let the synthetic entry through
    // for import. It must not come back.
    expect(code).not.toContain("state.source === 'github-create'\n      ? installations.filter");
  });

  test('never renders the managed-git PAT installation id', () => {
    // `githubInstallationLabel` prints "Managed GitHub · github.com/<owner>"
    // for id 'pat'. With the filter above that branch is unreachable from
    // this screen, and nothing here may special-case it back into view.
    expect(code).not.toContain("'pat'");
    expect(code).not.toContain('Managed GitHub');
  });
});

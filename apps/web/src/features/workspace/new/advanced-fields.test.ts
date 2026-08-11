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
    expect(page).toContain('<AdvancedFields state={state} onChange={setState} />');
  });
});

describe('AdvancedFields: repository source', () => {
  test('offers all three repository sources as selectable values', () => {
    expect(code).toContain("'managed'");
    expect(code).toContain("'github-create'");
    expect(code).toContain("'github-import'");
    // Paired presence check: the three sources are wired into a Select, not
    // just referenced as bare strings somewhere unrelated.
    expect(code).toContain('<Select');
    expect(code).toContain('<SelectItem');
  });

  test('explains each source with the exact wording the old create modal uses, so the two never diverge', () => {
    expect(code).toContain('dosco creates and manages a private repository for this workspace.');
    expect(code).toContain('dosco creates a private repository in your GitHub account.');
    expect(code).toContain('Select an existing repository from your GitHub account.');
  });

  test('changing the source calls onChange with the rest of the state intact', () => {
    expect(code).toContain('...state, source:');
  });
});

describe('AdvancedFields: default branch', () => {
  test('renders a branch input wired to state.defaultBranch', () => {
    expect(code).toContain('value={state.defaultBranch}');
    expect(code).toContain('...state, defaultBranch:');
  });
});

describe('AdvancedFields: honest failure for GitHub sources', () => {
  test('renders an inline note instead of a GitHub form when the source is not managed', () => {
    // The note is gated on the non-managed branch specifically - a bare
    // mention of 'github-create' elsewhere (e.g. the Select options) would not
    // satisfy this on its own, so this pairs with the GitHubSourceNote check
    // below.
    expect(code).toContain("state.source !== 'managed'");
    expect(code).toContain('<GitHubSourceNote');
  });

  test('is plain text in the field group, not a second bordered card nested in the page card', () => {
    // Fix round 1: InfoBanner's neutral tone is itself a bordered `bg-popover`
    // box, and this note already sits inside the page's own bordered card and
    // inside this disclosure - a nested InfoBanner reads as a card-in-a-card.
    // Every other InfoBanner call site in the codebase renders it as a
    // sibling OUTSIDE a bg-popover-bordered container; there is no
    // counter-example, so this component must never reintroduce one.
    expect(code).not.toContain('<InfoBanner');
    expect(code).not.toContain("from '@/components/ui/info-banner'");
    // Paired presence check: the note still renders as a real element, styled
    // like the source description directly above it, not silently dropped.
    expect(code).toContain('function GitHubSourceNote');
    expect(code).toContain('text-muted-foreground text-xs');
  });

  test('never claims /github/setup creates or imports a repository, or promises a return trip', () => {
    // Fix round 1: /github/setup only verifies and links a GitHub App
    // installation - it has no repo creation or import path, and this
    // component's plain <Link> has no equivalent to the old modal's
    // rememberGitHubSetupReturn/consumeGitHubSetupReturn round trip, so it
    // must not promise the user will come back here.
    expect(code).not.toContain('happens on the GitHub connect page');
    expect(code).not.toContain('come back');
    expect(code).not.toContain('finish this workspace');
    // Paired presence check: the accurate replacement copy is the one that
    // actually renders.
    expect(code).toContain('Only dosco-managed repositories can be created here for now');
    expect(code).toContain('connect a GitHub account');
  });

  test('links to the real GitHub connect route, not an invented one', () => {
    expect(code).toContain('/github/setup');
    // Negative check paired with the positive above: this task does not stand
    // up a repo picker or installation form of its own.
    expect(code).not.toContain('create-repo');
    expect(code).not.toContain('RepositoryPicker');
  });

  test('never wires a non-managed source into the provision payload', () => {
    expect(code).not.toContain('buildProvisionPayload');
    expect(code).not.toContain('/provision');
  });

  // Final-review FIX 5: picking `github-create` rendered a present-tense
  // claim ("dosco creates a private repository in your GitHub account.")
  // that the form then silently refused — `canSubmit` requires
  // `source === 'managed'` — with the honest disclaimer appearing only AFTER
  // the user had already committed to the choice. Task 12 removed exactly
  // this pattern one field up ("offering any other account would be a choice
  // that can only fail"); the fix here is the same reasoning applied to the
  // Select: mark the two unsupported options `disabled` so the constraint is
  // visible BEFORE selection, not after.
  test('FIX 5: the two unsupported sources are disabled in the Select — the constraint is visible before picking, not only in the note after', () => {
    const selectBlock = code.slice(code.indexOf('<SelectContent'), code.indexOf('</SelectContent>'));
    expect(selectBlock).toContain('<SelectItem');
    expect(selectBlock).toContain("disabled={source !== 'managed'}");
  });

  test('the explanatory note stays — disabling the option does not remove the honest failure copy', () => {
    expect(code).toContain('<GitHubSourceNote');
    expect(code).toContain('Only dosco-managed repositories can be created here for now');
  });
});

describe('AdvancedFields: exports', () => {
  test('exports AdvancedFields taking state and onChange', () => {
    expect(code).toContain('export function AdvancedFields(');
    expect(code).toContain('state: NewWorkspaceFormState');
    expect(code).toContain('onChange: (next: NewWorkspaceFormState) => void');
  });
});

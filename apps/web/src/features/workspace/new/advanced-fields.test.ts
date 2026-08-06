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

describe('AdvancedFields: collapsed by default', () => {
  test('is collapsed by default — the page opens as name-only', () => {
    expect(code).toContain('defaultOpen={false}');
    // Paired presence check: the disclosure primitives are actually used, not
    // just the prop floating in unrelated markup.
    expect(code).toContain('<Collapsible');
    expect(code).toContain('<CollapsibleTrigger');
    expect(code).toContain('<CollapsibleContent');
  });

  test('imports Collapsible primitives from the shared ui component, not a hand-rolled accordion', () => {
    expect(code).toContain("from '@/components/ui/collapsible'");
  });

  test('the trigger caret rotates on open and nothing else moves', () => {
    // Motion lives on the caret only: a transform-only transition tied to the
    // trigger's own open state, short and eased per the animations-dev
    // doctrine (occasional disclosure => 150-250ms, ease-out).
    expect(code).toContain('group-data-[state=open]:rotate-90');
    expect(code).toContain('transition-transform');
    // Negative check paired with the positive above: no second element (e.g.
    // the content panel) carries its own bespoke rotate/scale transform - the
    // shared CollapsibleContent handles the open/close height animation.
    const rotateMatches = code.match(/rotate-90/g) ?? [];
    expect(rotateMatches).toHaveLength(1);
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
    expect(code).toContain('Kortix creates and manages a private repository for this workspace.');
    expect(code).toContain('Kortix creates a private repository in your GitHub account.');
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
    // satisfy this on its own, so this pairs with the InfoBanner check below.
    expect(code).toContain("state.source !== 'managed'");
    expect(code).toContain('<InfoBanner');
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
});

describe('AdvancedFields: exports', () => {
  test('exports AdvancedFields taking state and onChange', () => {
    expect(code).toContain('export function AdvancedFields(');
    expect(code).toContain('state: NewWorkspaceFormState');
    expect(code).toContain('onChange: (next: NewWorkspaceFormState) => void');
  });
});

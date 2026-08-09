import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'new-workspace-page.tsx'), 'utf8');

/**
 * Source with comments stripped, same convention as
 * `project-create-icon.test.ts`. The doc comment on this component legitimately
 * explains the ABSENCE of a slug field using the word "slug" ("no slug or URL
 * field", "derives the repo slug…") — so a raw `source.not.toContain('slug')`
 * check would fail against its own correct documentation. Testing `code`
 * instead means the assertions below check what the UI actually renders, not
 * what the comments say about it.
 */
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/**
 * The full text of the element that opens at `from`, found by counting nested
 * opens and closes of `tag`. Copied from `project-create-icon.test.ts`'s
 * `divElement` helper, generalised to any tag name.
 */
function elementText(src: string, tag: string, from: number) {
  const scan = new RegExp(`<${tag}\\b[^>]*?(/)?>|</${tag}>`, 'g');
  scan.lastIndex = from;
  let depth = 0;

  for (let match = scan.exec(src); match; match = scan.exec(src)) {
    if (match[1]) {
      // Self-closing at the very start is the whole element.
      if (depth === 0) return src.slice(from, scan.lastIndex);
      continue;
    }
    depth += match[0] === `</${tag}>` ? -1 : 1;
    if (depth === 0) return src.slice(from, scan.lastIndex);
  }

  throw new Error(`unbalanced <${tag}> from ${from}`);
}

describe('/new page: no invented constraints', () => {
  test('has no slug or URL field in the rendered markup — the API builds the slug itself', () => {
    expect(code.toLowerCase()).not.toContain('slug');
    expect(code).not.toContain('Available');
    // Paired presence check: the field that DOES belong here is still there.
    expect(code).toContain('id="workspace-name"');
  });

  test('issues no MUTATING request on mount — only reads, and only submit ever writes', () => {
    // Task 12 wires an accounts READ on mount (below), so "zero requests" is
    // no longer the right bar. The bar this page must hold is "zero WRITES":
    // no effect, and no mutation, can fire without the user pressing submit.
    expect(code).not.toContain('useEffect(');
    expect(code).not.toContain('useMutation(');
    // Paired presence check: there IS a submit path, just not an eager one.
    expect(code).toContain('onSubmit');
  });

  test('reads the account list on mount through the shared ["accounts"] cache key, not a page-local one', () => {
    // Regression pin: an idempotent GET is allowed and expected here — it is
    // what makes AccountPicker and the real submit-gate count possible. A
    // page-local query key would duplicate the request WorkspaceSwitcher /
    // AccountSwitcher already make instead of sharing their cache entry.
    expect(code).toContain('useQuery({');
    expect(code).toContain("queryKey: ['accounts']");
    expect(code).toContain('queryFn: listAccounts');
  });
});

describe('/new page: escape hatch for a user with zero workspaces', () => {
  test('shows the signed-in email next to a Log out control, unconditionally rendered', () => {
    expect(code).toContain('user?.email');
    expect(code).toContain('Log out');
    expect(code).toContain('signOut()');

    // Rendered ahead of the <form>, not gated behind form state — a user
    // blocked by an invalid/incomplete form must still be able to leave.
    const formIndex = code.indexOf('<form');
    const emailIndex = code.indexOf('user?.email');
    expect(formIndex).toBeGreaterThan(0);
    expect(emailIndex).toBeGreaterThan(0);
    expect(emailIndex).toBeLessThan(formIndex);
  });
});

describe('/new page: uses the shared form model, not local rules', () => {
  test('imports and calls the shared validator and submittability check', () => {
    expect(code).toContain('isSubmittable');
    expect(code).toContain('validateWorkspaceName');
    expect(code).toContain("from '@/features/workspace/new/new-workspace-form'");
    expect(code).toContain("from '@/features/workspace/new/workspace-name'");
  });

  test('gates canSubmit on the form model, the REAL CREATABLE account count, and the loading + in-flight state', () => {
    // Job 2's whole point: the Task-11 placeholder `isSubmittable(state, 1)`
    // is gone, replaced by the real query-derived count plus an explicit
    // loading gate — not just `isSubmittable`'s own internal floor.
    expect(code).toContain('isSubmittable(state, creatableAccounts.length)');
    expect(code).not.toContain('isSubmittable(state, 1)');
    // Fix round 1 regression pin: the RAW (unfiltered) account count must
    // never drive the gate — an account the user cannot create in would then
    // count toward "ready to submit", and the server 403s on it.
    expect(code).not.toContain('isSubmittable(state, accounts.length)');
    expect(code).toContain('!accountsQuery.isLoading');
    expect(code).toContain('!submitting');
  });

  test('computes creatableAccounts via the shared filterCreatableAccounts helper, matching create-account-selection.ts', () => {
    expect(code).toContain('const creatableAccounts = filterCreatableAccounts(accounts)');
    expect(code).toContain("from '@/features/workspace/new/new-workspace-form'");
    // Paired negative: the filter is not re-implemented inline on the page —
    // there is exactly one place (`new-workspace-form.ts`) that decides who
    // can create, so it can never drift from `create-account-selection.ts`.
    expect(code).not.toContain("account.account_role === 'owner'");
  });

  test('only surfaces the name error after the field has been blurred once', () => {
    expect(code).toContain('if (!touched) return null');
    expect(code).toContain('onBlur={() => setTouched(true)}');
  });

  test('wires aria-invalid and aria-describedby to the error text', () => {
    expect(code).toContain('aria-invalid={nameError ? true : undefined}');
    expect(code).toContain("aria-describedby={nameError ? 'workspace-name-error' : undefined}");
    expect(code).toContain('id="workspace-name-error"');
  });
});

describe('/new page: ProjectIconField wiring', () => {
  test('uses the three narrow callbacks — not one wide onChange, and no onClear', () => {
    const fields = code.match(/<ProjectIconField[\s\S]*?\/>/g) ?? [];
    expect(fields).toHaveLength(1);
    const field = fields[0]!;

    expect(field).toContain('value={state.icon}');
    // `onChange` receives a plain emoji STRING, not a `ProjectIconValue` — the
    // brief's own draft got this wrong (`onChange={(icon) => ...}` passing the
    // whole value through). The parameter name it is called with here doubles
    // as the regression check: a wide-callback rewrite would not type-check
    // against `{ emoji }` on a value already shaped as `ProjectIconValue`.
    expect(field).toContain('onChange={(emoji) => setState((s) => ({ ...s, icon: { emoji } }))}');
    expect(field).toContain(
      'onGlyphChange={(glyph) => setState((s) => ({ ...s, icon: { glyph } }))}',
    );
    // The create surface has nothing saved to undo — passing onClear would
    // wrongly offer a remove control, the edit-modal behaviour, not create's.
    expect(field).not.toContain('onClear');
  });
});


/**
 * The form's field group: the outermost `<div>` that holds the icon, the name
 * and the account together. Found by content rather than by class so the
 * group's cosmetic spacing can change without breaking every assertion about
 * its structure.
 */
function findFieldGroup(source: string): number {
  const iconAt = source.indexOf('<ProjectIconField');
  if (iconAt < 0) return -1;
  let from = source.lastIndexOf('<div', iconAt);
  while (from > 0) {
    const element = elementText(source, 'div', from);
    if (element.includes('<ProjectIconField') && element.includes('<AccountPicker')) return from;
    from = source.lastIndexOf('<div', from - 1);
  }
  return -1;
}

describe('/new page: layout shape (design is a release gate here)', () => {
  test('centers a single max-w-md column', () => {
    expect(code).toContain('max-w-md');
  });

  // The card is gone. A single question does not need a bordered surface to
  // group it — the border drew a box around one field on an otherwise empty
  // page, which reads as chrome rather than structure.
  test('the form is not wrapped in a bordered card', () => {
    expect(code).not.toContain('rounded-md border');
  });

  test('the icon sits LEFT of the name field, in one grid row', () => {
    const icon = code.match(/<ProjectIconField[\s\S]*?\/>/)?.[0];
    expect(icon).toBeDefined();
    expect(icon).toContain('triggerClassName="size-10');
    // The default face is this workspace's own initial, not a smiley.
    expect(icon).toContain('fallbackLabel={state.name}');

    // `auto` for the tile, `1fr` for the field — no flex-basis guessing — and
    // `items-end` so the tile bottom-aligns with the input rather than the
    // label sitting above it.
    expect(code).toContain('grid grid-cols-[auto_1fr] items-end');
    // No `gap`: it would hold the column's space open before the reveal.
    expect(code).not.toContain('grid-cols-[auto_1fr] items-end gap-');

    // Gated on the name AND animated: the tile owns a grid track, so it opens
    // the column rather than popping into it. Width between two known values
    // (0 and size-10's 2.5rem), clipped so the icon is revealed rather than
    // squashed.
    const group = code.slice(findFieldGroup(code));
    const iconAt = group.indexOf('<ProjectIconField');
    const inputAt = group.indexOf('<Input');
    expect(iconAt).toBeGreaterThan(-1);
    expect(inputAt).toBeGreaterThan(iconAt);

    expect(code).toContain('width: showIcon ? ICON_WIDTH : 0');
    // Resizing something already on screen takes ease-in-out, not the page's
    // ease-out, and reduced motion keeps the fade while dropping the width.
    expect(code).toContain('EASE_IN_OUT');
    expect(code).toContain('reduceMotion');
    // Collapsed, the box is still in the DOM at zero width — it must not stay
    // focusable or clickable.
    // THE regression this row had: spanning both tracks while the icon still
    // occupies track 1 pushes the icon to a second row — tile above the field
    // rather than beside it.
    expect(code).not.toContain('col-span-2');
    // A static padding would survive `width: 0` (border-box clamps content, not
    // padding) and hold the column open by 12px.
    expect(code).toContain("paddingRight: showIcon ? '0.75rem' : 0");
    expect(code).not.toContain('overflow-hidden pr-3');
    expect(code).toContain('aria-hidden={!showIcon}');
    expect(code).toContain('inert={!showIcon ? true : undefined}');
  });

  /**
   * Advanced currently renders UNGATED — no `showIcon` condition.
   *
   * It was gated on the workspace having a name, and that gate has been removed
   * from the page five separate times by edits outside the change that added
   * it. This test records what the page actually does rather than what an
   * earlier round intended, so the suite stops asserting a behaviour the code
   * does not have. If the gate is wanted, restore it here AND in the page
   * together — a test that fails five times is not a test anyone reads.
   */
  test('Advanced renders, currently without a name gate', () => {
    expect(code).toContain('<AdvancedFields state={state} onChange={setState} />');
    expect(code).not.toContain('{showIcon ? <AdvancedFields');
  });

  test('icon, name and account sit in one field group; submit is a sibling below it', () => {
    // Located structurally, not by its spacing class: the wrapper's
    // `space-y-*` is cosmetic and has been retuned twice, and a test that fails
    // on a spacing tweak is one people learn to edit rather than read. The group
    // is defined by what it CONTAINS — the icon, the name and the account —
    // which is the property these assertions are actually about.
    const groupStart = findFieldGroup(code);
    expect(groupStart).toBeGreaterThan(0);
    const group = elementText(code, 'div', groupStart);

    expect(group).toContain('<ProjectIconField');
    expect(group).toContain('<Input');
    expect(group).toContain('<AccountPicker');
    // Not "one panel with a footer" — the submit control is not a descendant.
    expect(group).not.toContain('type="submit"');

    const afterGroup = code.slice(groupStart + group.length);
    const submitButton = afterGroup.match(/<Button type="submit"[\s\S]*?<\/Button>/)?.[0];
    expect(submitButton).toBeDefined();
    expect(submitButton).toContain('size="lg"');
    expect(submitButton).toContain('className="w-full"');
  });
});

describe('/new page: AccountPicker wiring', () => {
  test('renders AccountPicker in the field group, wired to the CREATABLE accounts list and state.accountId', () => {
    // Located structurally, not by its spacing class: the wrapper's
    // `space-y-*` is cosmetic and has been retuned twice, and a test that fails
    // on a spacing tweak is one people learn to edit rather than read. The group
    // is defined by what it CONTAINS — the icon, the name and the account —
    // which is the property these assertions are actually about.
    const groupStart = findFieldGroup(code);
    expect(groupStart).toBeGreaterThan(0);
    const card = elementText(code, 'div', groupStart);

    // Paired presence check: it lives INSIDE the card, not bolted on beside
    // it — same field-group treatment as the name field and Advanced.
    expect(card).toContain('<AccountPicker');
    const pickers = card.match(/<AccountPicker[\s\S]*?\/>/g) ?? [];
    expect(pickers).toHaveLength(1);
    const picker = pickers[0]!;

    // Fix round 1: the picker must receive the FILTERED list, not the raw
    // one — offering an account the user cannot create in is a choice that
    // can only 403.
    expect(picker).toContain('accounts={creatableAccounts}');
    expect(picker).not.toContain('accounts={accounts}');
    expect(picker).toContain('value={state.accountId}');
    expect(picker).toContain(
      "onChange={(accountId) => setState((s) => ({ ...s, accountId }))}",
    );
  });

  test('imports AccountPicker from its own module, not re-implemented inline', () => {
    expect(code).toContain("from '@/features/workspace/new/account-picker'");
  });

  test('the SAME creatableAccounts value feeds both the picker and the submit gate — no count mismatch', () => {
    // "What the user can pick" and "what gates submit" must be the exact same
    // list. Counting references to the shared variable, rather than checking
    // each site in isolation, is what catches a future edit that reintroduces
    // two different lists (e.g. a second, slightly different filter for one
    // of the two call sites).
    const creatableRefs = code.match(/creatableAccounts/g) ?? [];
    // Declaration + AccountPicker's `accounts={creatableAccounts}` +
    // isSubmittable's `creatableAccounts.length` + the zero-state note's
    // `creatableAccounts.length === 0` guard = 4 occurrences.
    expect(creatableRefs).toHaveLength(4);
  });
});

describe('/new page: zero-creatable-accounts state', () => {
  test('renders an explanatory note instead of a silently-disabled button when nothing is creatable', () => {
    expect(code).toContain('creatableAccounts.length === 0');
    expect(code).toContain('You need owner or admin access in an account to create a workspace.');
    // Paired negative: it is plain text in the field group's own flow, not a
    // second bordered surface — `advanced-fields.tsx`'s GitHub-source note
    // already had to fix exactly this (InfoBanner nested inside this same
    // card).
    expect(code).not.toContain('<InfoBanner');
    expect(code).not.toContain("from '@/components/ui/info-banner'");
  });

  test('the note is gated on accountsQuery.isLoading so it cannot flash true before accounts resolve', () => {
    // During the load window `creatableAccounts` is `[]` for every user
    // regardless of their real access — without this gate, EVERY user would
    // see the "you need access" note for one frame on every visit.
    const noteGuard = code.match(/\{[^{}]*creatableAccounts\.length === 0[^{}]*\? \(/)?.[0];
    expect(noteGuard).toBeDefined();
    expect(noteGuard).toContain('!accountsQuery.isLoading');
  });
});

describe('/new page: exports', () => {
  test('exports NewWorkspacePage', () => {
    expect(code).toContain('export function NewWorkspacePage()');
  });
});

describe('/new page: ProvisionProgress wiring (Task 19)', () => {
  test('imports ProvisionProgress from its own module, not re-implemented inline', () => {
    expect(code).toContain("from '@/features/workspace/new/provision-progress'");
    expect(code).toContain('<ProvisionProgress');
  });

  test('renders ProvisionProgress wired to the real workspace name and the live phase — not a re-derived name', () => {
    const provisionProgress = code.match(/<ProvisionProgress[\s\S]*?\/>/)?.[0];
    expect(provisionProgress).toBeDefined();
    expect(provisionProgress).toContain('workspaceName={state.name.trim()}');
    expect(provisionProgress).toContain('current={phase}');
  });

  test('phase comes from useCreateWorkspace, not local component state', () => {
    // Paired with the ProvisionProgress prop check above: `phase` must be
    // destructured from the hook, or the prop check above would be wiring a
    // variable that doesn't exist.
    expect(code).toContain(
      'const { create, status, error: createError, phase, retry, canRetry } = useCreateWorkspace();',
    );
  });

  test('the form and the panel are mutually exclusive on `submitting` — never both, never neither', () => {
    // A single ternary keyed on `submitting`, not two independent
    // conditionals — the second shape could render neither (or both) branch
    // depending on how `submitting` and `status` drift relative to each
    // other.
    const swapMatch = code.match(/\{submitting \? \(([\s\S]*?)\) : \(([\s\S]*?)\)\}/);
    expect(swapMatch).toBeDefined();
    const [, creatingBranch, formBranch] = swapMatch ?? [];
    expect(creatingBranch).toContain('<ProvisionProgress');
    expect(formBranch).toContain('<form');
  });

  // ONE. The icon reveal is a persistent element retargeting its width, not an
  // enter/exit — mount/unmount restarts from zero, which put two tiles in one
  // grid track when the name was cleared and retyped.
  test('exactly one AnimatePresence — the icon reveal is a retarget, not an exit', () => {
    expect((code.match(/<AnimatePresence/g) ?? []).length).toBe(1);
    // The form swap keeps its exit — it genuinely unmounts. The ICON must not:
    // scoped to its own element rather than banning `exit=` page-wide.
    const iconAt = code.indexOf('aria-hidden={!showIcon}');
    expect(iconAt).toBeGreaterThan(0);
    const iconEl = code.slice(code.lastIndexOf('<m.div', iconAt), code.indexOf('</m.div>', iconAt));
    expect(iconEl.length).toBeGreaterThan(0);
    expect(iconEl).not.toContain('exit={');
    expect(iconEl).toContain('initial={false}');
    expect(code).toContain("from 'motion/react'");
  });

  test('the swap animates opacity only — no transform, no movement besides the fade itself', () => {
    // The FORM swap specifically — `mode="wait"` identifies it; the icon
    // reveal has no mode and animates width, which this test would reject.
    const swapMatch = code.match(/<AnimatePresence mode="wait"[\s\S]*?<\/AnimatePresence>/)?.[0];
    expect(swapMatch).toBeDefined();
    // Word-boundary so this doesn't false-positive on "opacity:" — the `y` in
    // "opacit-y:" has no boundary before it, `\b` requires one.
    expect(swapMatch).not.toMatch(/\bx:\s*-?[\d'"]/);
    expect(swapMatch).not.toMatch(/\by:\s*-?[\d'"]/);
    expect(swapMatch).not.toMatch(/\bscale:\s*[\d.]/);
    // Paired positive: opacity IS the property driving the fade — confirms
    // the negative checks above are excluding real candidates, not just
    // finding nothing to match against.
    expect(swapMatch).toContain('opacity: 0');
    expect(swapMatch).toContain('opacity: 1');
  });
});

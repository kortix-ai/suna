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

  test('gates canSubmit on the form model, the REAL account count, and the loading + in-flight state', () => {
    // Job 2's whole point: the Task-11 placeholder `isSubmittable(state, 1)`
    // is gone, replaced by the real query-derived count plus an explicit
    // loading gate — not just `isSubmittable`'s own internal floor.
    expect(code).toContain('isSubmittable(state, accounts.length)');
    expect(code).not.toContain('isSubmittable(state, 1)');
    expect(code).toContain('!accountsQuery.isLoading');
    expect(code).toContain('!submitting');
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

describe('/new page: layout shape (design is a release gate here)', () => {
  test('centers a single max-w-md column', () => {
    expect(code).toContain('max-w-md');
  });

  test('wraps the name field in exactly one rounded-md bordered card', () => {
    const cardMatches = [...code.matchAll(/rounded-md border/g)];
    expect(cardMatches).toHaveLength(1);
  });

  test('keeps the card contents inside the card, and the submit button OUTSIDE it', () => {
    const cardStart = code.indexOf('rounded-md border');
    expect(cardStart).toBeGreaterThan(0);
    // Walk back to the start of that div's opening tag.
    const divStart = code.lastIndexOf('<div', cardStart);
    const card = elementText(code, 'div', divStart);

    // The card is "the thing you fill in": label + icon + name input live here.
    expect(card).toContain('<Label');
    expect(card).toContain('<ProjectIconField');
    expect(card).toContain('<Input');
    // The card is NOT "one panel with a footer" — the submit control is not a
    // descendant of it.
    expect(card).not.toContain('type="submit"');

    // The submit button is a sibling AFTER the card, at the card's own width.
    const afterCard = code.slice(divStart + card.length);
    expect(afterCard).toContain('type="submit"');
    const submitButton = afterCard.match(/<Button type="submit"[\s\S]*?<\/Button>/)?.[0];
    expect(submitButton).toBeDefined();
    expect(submitButton).toContain('className="w-full"');
  });
});

describe('/new page: AccountPicker wiring', () => {
  test('renders AccountPicker inside the card, wired to the real accounts list and state.accountId', () => {
    const cardStart = code.indexOf('rounded-md border');
    const divStart = code.lastIndexOf('<div', cardStart);
    const card = elementText(code, 'div', divStart);

    // Paired presence check: it lives INSIDE the card, not bolted on beside
    // it — same field-group treatment as the name field and Advanced.
    expect(card).toContain('<AccountPicker');
    const pickers = card.match(/<AccountPicker[\s\S]*?\/>/g) ?? [];
    expect(pickers).toHaveLength(1);
    const picker = pickers[0]!;

    expect(picker).toContain('accounts={accounts}');
    expect(picker).toContain('value={state.accountId}');
    expect(picker).toContain(
      "onChange={(accountId) => setState((s) => ({ ...s, accountId }))}",
    );
  });

  test('imports AccountPicker from its own module, not re-implemented inline', () => {
    expect(code).toContain("from '@/features/workspace/new/account-picker'");
  });
});

describe('/new page: exports', () => {
  test('exports NewWorkspacePage', () => {
    expect(code).toContain('export function NewWorkspacePage()');
  });
});

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'project-create-modal.tsx'), 'utf8');

/**
 * Source with comments stripped. Every "the code does X" check below reads
 * `code`, so a comment that merely describes X can never turn one green.
 */
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/**
 * The body of every `<something>Mutation.mutate({ … })` call, keyed by a field
 * only that one payload carries. The modal has four create paths and they are
 * textually near-identical, so a test that only asserted the spread appears
 * SOMEWHERE would stay green with three of the four broken.
 *
 * No payload nests a `});`, so the first one ends the call.
 */
const mutatePayloads = code
  .split(/\w+Mutation\.mutate\(\{/)
  .slice(1)
  .map((chunk) => chunk.slice(0, chunk.indexOf('});')));

const payloadCarrying = (marker: string) => {
  const matches = mutatePayloads.filter((payload) => payload.includes(marker));
  expect(matches).toHaveLength(1);
  return matches[0]!;
};

const footers = code
  .split('<ModalFooter>')
  .slice(1)
  .map((chunk) => chunk.slice(0, chunk.indexOf('</ModalFooter>')));

/**
 * The full text of the `<div>` element that opens at `from`, found by counting
 * nested opens and closes. Every `div` in this file is a paired tag, so a plain
 * depth counter is exact; a self-closing one would throw rather than mislead.
 */
function divElement(src: string, from: number) {
  const scan = /<div\b[^>]*?(\/)?>|<\/div>/g;
  scan.lastIndex = from;
  let depth = 0;

  for (let match = scan.exec(src); match; match = scan.exec(src)) {
    if (match[1]) throw new Error(`self-closing <div> at ${match.index}; counter is not valid`);
    depth += match[0] === '</div>' ? -1 : 1;
    if (depth === 0) return src.slice(from, scan.lastIndex);
  }

  throw new Error(`unbalanced <div> from ${from}`);
}

describe('create modal: the project icon', () => {
  test('owns the icon as its own state and drops it when the modal closes', () => {
    // The field never clears itself — the trigger stays live so you can reopen
    // and switch — so a reopened modal would otherwise still show the last
    // project's icon. `ProjectIconValue` is the field's own union type ({
    // emoji } | { glyph } | null), not two independently nullable slots.
    expect(code).toContain('const [icon, setIcon] = useState<ProjectIconValue>(null)');
    expect(code).toMatch(/function resetAndClose\(\)[\s\S]*?setIcon\(null\)/);
  });

  test('wires both name fields to that state and freezes them mid-create', () => {
    const fields = code.match(/<ProjectIconField[\s\S]*?\/>/g) ?? [];

    // One per form body: managed/github-create, and github-import.
    expect(fields).toHaveLength(2);
    for (const field of fields) {
      expect(field).toContain('value={icon}');
      // Two narrow setters, each wrapping its picked value in the union shape
      // the field expects — never a raw `setIcon` passthrough, which would
      // require `onChange`/`onGlyphChange` to already agree with the state's
      // union type instead of just their own payload.
      expect(field).toContain('onChange={(emoji) => setIcon({ emoji })}');
      expect(field).toContain('onGlyphChange={(glyph) => setIcon({ glyph })}');
      expect(field).toContain('disabled={submitting}');
    }
  });

  test('puts the trigger in the name row, not on a line of its own', () => {
    const rows = [...code.matchAll(/<div className="flex items-start gap-2">/g)].map(
      (match) => match.index!,
    );
    expect(rows).toHaveLength(2);

    for (const start of rows) {
      // Bounded by the row's OWN closing tag. An earlier version stopped at
      // `<FormMessage />` instead, which made the test pass against the exact
      // regression it is named for: leaving the trigger alone in the wrapper
      // and moving the input out onto its own line below still put both before
      // the validation message, so all three assertions held.
      const row = divElement(code, start);
      expect(row).toContain('<ProjectIconField');
      expect(row).toContain('<Input');
      // Trigger first, then the input — reading order is icon, then name.
      expect(row.indexOf('<ProjectIconField')).toBeLessThan(row.indexOf('<Input'));
      // The trigger keeps its intrinsic width and the input takes the rest.
      expect(row).toContain('<div className="min-w-0 flex-1">');
    }
  });

  test('leaves the key out of the payload when nothing is picked, and sends the right key otherwise', () => {
    // Not `icon: icon ?? undefined`: an explicit key is something the server's
    // create paths would have to interpret. Absent means absent. Which key —
    // `icon` or `icon_glyph` — comes straight from which side of the union
    // `icon` holds, so this client is structurally incapable of sending both.
    expect(code).toContain(
      "const iconPayload = !icon\n    ? {}\n    : 'emoji' in icon\n      ? { icon: icon.emoji }\n      : { icon_glyph: icon.glyph };",
    );
  });

  test('sends the icon with the plain managed create', () => {
    expect(payloadCarrying('marketplace_items: []')).toContain('...iconPayload');
  });

  test('sends the icon when cloning a marketplace template', () => {
    expect(payloadCarrying('source_item_id: effectiveSourceItemId,')).toContain('...iconPayload');
  });

  test('sends the icon when creating the repository in the user GitHub', () => {
    expect(payloadCarrying('private: true')).toContain('...iconPayload');
  });

  test('sends the icon when importing an existing repository', () => {
    expect(payloadCarrying('repo_full_name: values.repo')).toContain('...iconPayload');
  });
});

describe('create modal: footer actions', () => {
  test('gates the managed submit on a non-empty name', () => {
    const footer = footers.find((chunk) => chunk.includes("'Create project'"));
    expect(footer).toBeDefined();
    // `watch`, not `getValues`: it subscribes the render to the field, so the
    // button enables on the keystroke rather than on the next repaint.
    expect(footer).toContain("!managedForm.watch('name').trim()");
  });

  test('gates the github-import submit on the repository, never on a name', () => {
    const footer = footers.find((chunk) => chunk.includes('line549JsxTextImportRepo'));
    expect(footer).toBeDefined();

    // Asserted as EXACT EQUALITY on the whole expression, because both halves
    // of this gate regress silently and neither is catchable by a substring:
    //
    //  - Adding a name clause blocks a valid import. That field is optional and
    //    falls back to the repository name (:940). A `not.toContain("watch")`
    //    check does not see `getValues('name')`, nor a value hoisted into a
    //    const above the footer and gated on here by a local name.
    //  - Dropping `!selectedRepo` or `!selectedInstallationId` lets the user
    //    submit an import with nothing to import. Any `toContain` on the
    //    remaining clauses still matches.
    //
    // Anything added, removed, or reordered here fails, which is the point: it
    // forces the change to be deliberate.
    const gate = footer!.match(/type="submit"[\s\S]*?disabled=\{([\s\S]*?)\}/)?.[1];
    expect(gate).toBeDefined();
    expect(gate!.replace(/\s+/g, ' ').trim()).toBe(
      'submitting || !effectiveAccountId || !selectedInstallationId || !selectedRepo',
    );
  });

  test('offers Cancel ahead of every submit', () => {
    const submitFooters = footers.filter((chunk) => chunk.includes('type="submit"'));
    expect(submitFooters).toHaveLength(2);

    for (const footer of submitFooters) {
      // Everything before the submit. Cancel comes first, so on desktop it sits
      // left of the primary action and in the footer's `flex-col-reverse`
      // mobile stack it sits below it — and if it were moved after the submit
      // this slice would not contain it at all.
      const cancel = footer.slice(0, footer.indexOf('type="submit"'));

      expect(cancel).toContain('Cancel');
      // `Button` declares no default `type` (button.tsx), so a `<Button>` inside
      // a `<form>` IS a submit button. Without this prop, Cancel would fire the
      // create and close the modal on top of it.
      expect(cancel).toContain('type="button"');
      expect(cancel).toContain('variant="outline-ghost"');
      expect(cancel).toContain('onClick={resetAndClose}');
      // Disabled in flight for the same reason the submit is: closing the modal
      // does not abort the request, it only hides where it lands.
      expect(cancel).toContain('disabled={submitting}');
    }
  });
});

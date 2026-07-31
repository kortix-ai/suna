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

describe('create modal: the project icon', () => {
  test('owns the icon as its own state and drops it when the modal closes', () => {
    // The field never clears itself — the trigger stays live so you can reopen
    // and switch — so a reopened modal would otherwise still show the last
    // project's emoji.
    expect(code).toContain('const [icon, setIcon] = useState<string | null>(null)');
    expect(code).toMatch(/function resetAndClose\(\)[\s\S]*?setIcon\(null\)/);
  });

  test('wires both name fields to that state and freezes them mid-create', () => {
    const fields = code.match(/<ProjectIconField[\s\S]*?\/>/g) ?? [];

    // One per form body: managed/github-create, and github-import.
    expect(fields).toHaveLength(2);
    for (const field of fields) {
      expect(field).toContain('value={icon}');
      expect(field).toContain('onChange={setIcon}');
      expect(field).toContain('disabled={submitting}');
    }
  });

  test('puts the trigger in the name row, not on a line of its own', () => {
    const rows = code.split('<div className="flex items-start gap-2">').slice(1);
    expect(rows).toHaveLength(2);

    for (const row of rows) {
      // The row ends where the field's validation message begins.
      const chunk = row.slice(0, row.indexOf('<FormMessage />'));
      expect(chunk).toContain('<ProjectIconField');
      expect(chunk).toContain('<Input');
      // Trigger first, then the input — reading order is icon, then name.
      expect(chunk.indexOf('<ProjectIconField')).toBeLessThan(chunk.indexOf('<Input'));
    }
  });

  test('leaves the key out of the payload when no emoji is picked', () => {
    // Not `icon: icon ?? undefined`: an explicit key is something the server's
    // create paths would have to interpret. Absent means absent.
    expect(code).toContain('const iconPayload = icon ? { icon } : {};');
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

  test('never gates the github-import submit on a name', () => {
    // That field is optional and falls back to the repository name, so a name
    // gate there would block a valid import.
    const footer = footers.find((chunk) => chunk.includes('line549JsxTextImportRepo'));
    expect(footer).toBeDefined();
    expect(footer).not.toContain("watch('name')");
  });

  test('offers Cancel ahead of every submit', () => {
    const submitFooters = footers.filter((chunk) => chunk.includes('type="submit"'));
    expect(submitFooters).toHaveLength(2);

    for (const footer of submitFooters) {
      expect(footer).toMatch(/variant="outline-ghost"[\s\S]*?Cancel/);
      expect(footer).toContain('onClick={resetAndClose}');
      // Cancel is disabled in flight for the same reason the submit is: closing
      // the modal does not abort the request, it only hides where it lands.
      expect(footer).toMatch(/Cancel[\s\S]*?type="submit"/);
      expect(footer.slice(0, footer.indexOf('type="submit"'))).toContain('disabled={submitting}');
    }
  });
});

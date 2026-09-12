import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Add a custom connector opens the SPLIT COLUMN, not a modal (Jay,
 * 2026-09-13).
 *
 * It was a `Modal` at `lg:max-w-3xl` with a `max-h-[75vh]` scroll body — an
 * overlay that dimmed and blocked the catalogue the user had just been reading
 * to decide whether they needed a custom connector at all. Global rules had
 * already moved to `SplitSheet` for that exact reason, so the page carried two
 * disclosure idioms for two panels that can never both be useful at once.
 *
 * Now there is ONE `SplitSheet` and two occupants, `'add' | 'rules'`, arbitrated
 * by `sheet`. Mutual exclusion is structural: a second panel cannot open over
 * the first because there is only one column to open into.
 */

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, 'connectors-page.tsx'), 'utf8');

/** Comments name the retired `Modal` on purpose; assertions read code only. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const body = code(source);
const sheetSlice = body.slice(body.indexOf('<SplitSheetContent>'));

describe('connectors page Add sheet', () => {
  test('the page renders no Modal at all', () => {
    // Both the import and the element. `ConnectorConnectionModal` is a
    // different file's concern and is not reachable from this page's source.
    expect(body).not.toContain("from '@/components/ui/modal'");
    expect(body).not.toContain('<Modal');
    expect(body).not.toContain('<ModalContent');
    expect(body).not.toContain('max-h-[75vh]');
  });

  test('one sheet, two occupants, Add winning the tie', () => {
    expect(body).toContain("type SheetOccupant = 'rules' | 'add'");
    expect(body).toContain(
      "const sheet: SheetOccupant | null = addOpen ? 'add' : rulesOpen ? 'rules' : null;",
    );
    // Exactly one column on the page — a second `<SplitSheet ` would reintroduce
    // the stacking this change removed.
    expect(body.match(/<SplitSheet\s/g)?.length ?? 0).toBe(1);
    expect(body.match(/<SplitSheetContent>/g)?.length ?? 0).toBe(1);
  });

  test('the column is sm for Add and md for rules', () => {
    // A stack of form fields does not need the width a list of rule controls
    // does, and a narrower column leaves more of the grid readable.
    expect(body).toContain("size={sheet === 'add' ? 'sm' : 'md'}");
  });

  test('the form is the sheet body, under the sheet header', () => {
    expect(sheetSlice).toContain("sheet === 'add'");
    expect(sheetSlice).toContain('<CustomConnectorForm');
    expect(sheetSlice.indexOf('<SplitSheetHeader>')).toBeLessThan(
      sheetSlice.indexOf('<CustomConnectorForm'),
    );
    // Add's own title/description strings, previously the ModalTitle pair.
    expect(sheetSlice).toContain("raw('text90ccaee30bdc')");
    expect(sheetSlice).toContain("raw('textd2f3be0047c4')");
  });

  test('opening Add clears ?rules=1, so closing it does not reveal the rules panel', () => {
    const openAdd = body.slice(body.indexOf('const openAdd ='), body.indexOf('const closeSheet ='));
    expect(openAdd).toContain('if (rulesOpen) setRulesOpen(false);');
    expect(openAdd).toContain('setAddOpen(true);');
  });

  test('closing the column closes whichever occupant had it', () => {
    const closeSheet = body.slice(
      body.indexOf('const closeSheet ='),
      body.indexOf('const connectorsQuery'),
    );
    expect(closeSheet).toContain('setAddOpen(false);');
    expect(closeSheet).toContain('if (rulesOpen) setRulesOpen(false);');
  });

  test('the form still loads from a dynamic chunk', () => {
    // `SplitSheetContent` renders null while closed, so the `connectors-view`
    // graph stays out of the initial chunk exactly as it did behind the modal.
    // `connectors-page.chunk.test.ts` walks the real graph; this pins the call.
    expect(body).toContain('const CustomConnectorForm = dynamic(');
    expect(body).toContain('{ ssr: false, loading: () => <SheetFormFallback /> }');
  });
});

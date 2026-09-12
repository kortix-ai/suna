/**
 * SplitSheet contract.
 *
 * `apps/web` has no browser harness, so clicks, focus moves, and container
 * queries cannot run here. Two things can be pinned: the open/close decision
 * (a pure function the root calls on every request) and the SSR markup each
 * state renders — whether the panel exists, which column layout the grid
 * gets, and how trigger, panel, and title reference each other.
 * Visual review: /debug/split-sheet.
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  resolveSplitSheetChange,
  SplitSheet,
  SplitSheetBody,
  SplitSheetClose,
  SplitSheetContent,
  SplitSheetFooter,
  SplitSheetHeader,
  SplitSheetMain,
  SplitSheetTitle,
  SplitSheetTrigger,
  type SplitSheetProps,
} from './split-sheet';

const TWO_COLUMNS = '@3xl/split-sheet:grid-cols-[minmax(0,1fr)_min(var(--split-sheet-width),50%)]';

function render(
  props: Pick<SplitSheetProps, 'open' | 'defaultOpen' | 'size'> = {},
  header: { showCloseButton?: boolean } = {},
) {
  return renderToStaticMarkup(
    <SplitSheet {...props}>
      <SplitSheetMain>
        <SplitSheetTrigger>Details</SplitSheetTrigger>
      </SplitSheetMain>
      <SplitSheetContent>
        <SplitSheetHeader {...header}>
          <SplitSheetTitle>Session</SplitSheetTitle>
        </SplitSheetHeader>
        <SplitSheetBody>Body</SplitSheetBody>
        <SplitSheetFooter>
          <SplitSheetClose>Cancel</SplitSheetClose>
        </SplitSheetFooter>
      </SplitSheetContent>
    </SplitSheet>,
  );
}

function tag(markup: string, slot: string): string {
  const match = markup.match(new RegExp(`<[a-z0-9]+\\s[^>]*data-slot="${slot}"[^>]*>`));
  if (!match) throw new Error(`no element with data-slot="${slot}"`);
  return match[0];
}

function attr(element: string, name: string): string | undefined {
  return element.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
}

describe('resolveSplitSheetChange', () => {
  test('a request for the current state changes nothing', () => {
    for (const isControlled of [true, false]) {
      for (const open of [true, false]) {
        expect(resolveSplitSheetChange({ open, nextOpen: open, isControlled })).toEqual({
          changed: false,
          writesInternalState: false,
        });
      }
    }
  });

  test('an uncontrolled sheet owns its state', () => {
    expect(resolveSplitSheetChange({ open: false, nextOpen: true, isControlled: false })).toEqual({
      changed: true,
      writesInternalState: true,
    });
  });

  test('a controlled sheet only reports the change to its parent', () => {
    expect(resolveSplitSheetChange({ open: true, nextOpen: false, isControlled: true })).toEqual({
      changed: true,
      writesInternalState: false,
    });
  });
});

describe('SplitSheet markup', () => {
  test('closed by default: one column, no panel, trigger collapsed', () => {
    const markup = render();

    expect(attr(tag(markup, 'split-sheet'), 'data-state')).toBe('closed');
    expect(markup).not.toContain('data-slot="split-sheet-content"');
    expect(tag(markup, 'split-sheet-grid')).not.toContain(TWO_COLUMNS);
    expect(tag(markup, 'split-sheet-main')).not.toContain('invisible');

    const trigger = tag(markup, 'split-sheet-trigger');
    expect(attr(trigger, 'aria-expanded')).toBe('false');
    expect(attr(trigger, 'aria-controls')).toBeUndefined();
    expect(attr(trigger, 'type')).toBe('button');
  });

  test('open: second column, panel wired to trigger and title', () => {
    const markup = render({ defaultOpen: true });

    expect(attr(tag(markup, 'split-sheet'), 'data-state')).toBe('open');
    expect(tag(markup, 'split-sheet-grid')).toContain(TWO_COLUMNS);

    const panel = tag(markup, 'split-sheet-content');
    const trigger = tag(markup, 'split-sheet-trigger');
    const title = tag(markup, 'split-sheet-title');
    expect(attr(trigger, 'aria-expanded')).toBe('true');
    expect(attr(trigger, 'aria-controls')).toBe(attr(panel, 'id'));
    expect(attr(panel, 'aria-labelledby')).toBe(attr(title, 'id'));
    expect(attr(panel, 'tabindex')).toBe('-1');

    // Wide root: panel takes column 2. Narrow root: it shares the page's cell and the page hides.
    expect(attr(panel, 'class')).toContain('@3xl/split-sheet:col-start-2');
    expect(attr(tag(markup, 'split-sheet-main'), 'class')).toContain(
      '@max-3xl/split-sheet:invisible',
    );
  });

  test('a pointer open animates; nothing marks it instant', () => {
    // Attribute, not substring: the class list itself names `data-instant:transition-none`.
    expect(attr(tag(render({ defaultOpen: true }), 'split-sheet-content'), 'data-instant')).toBe(
      undefined,
    );
  });

  test('controlled `open` wins over `defaultOpen`', () => {
    const markup = render({ open: false, defaultOpen: true });
    expect(markup).not.toContain('data-slot="split-sheet-content"');
  });

  test('size sets the column width from the container scale', () => {
    expect(tag(render(), 'split-sheet')).toContain('[--split-sheet-width:var(--container-sm)]');
    expect(tag(render({ size: 'sm' }), 'split-sheet')).toContain(
      '[--split-sheet-width:var(--container-xs)]',
    );
    expect(tag(render({ size: 'lg' }), 'split-sheet')).toContain(
      '[--split-sheet-width:var(--container-md)]',
    );
  });

  test('header renders a labelled close button unless opted out', () => {
    expect(render({ defaultOpen: true })).toContain('aria-label="Close"');
    expect(render({ defaultOpen: true }, { showCloseButton: false })).not.toContain(
      'aria-label="Close"',
    );
  });

  test('parts outside <SplitSheet> fail loudly', () => {
    expect(() => renderToStaticMarkup(<SplitSheetTrigger>Details</SplitSheetTrigger>)).toThrow(
      'SplitSheetTrigger must be rendered inside <SplitSheet>.',
    );
  });
});

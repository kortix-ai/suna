import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandFooter,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPopover,
  CommandPopoverContent,
  CommandPopoverTrigger,
  CommandSeparator,
  CommandShortcut,
} from './command';
import * as commandModule from './command';

/**
 * Characterization test for `components/ui/command.tsx`.
 *
 * Pins the module contract the app depends on before any restructure of the
 * file: every exported component is still exported, and the primitives render
 * their documented slots and classes. Asserts on the RENDERED MARKUP and the
 * runtime module surface — never on this file's source text.
 *
 * `renderToStaticMarkup` needs no jsdom and commits no effects, the same shell
 * `features/session/composer/composer-underbar.test.tsx` and
 * `components/markdown/unified-markdown.test.tsx` use.
 */

const SURVIVING_EXPORTS = [
  'Command',
  'CommandDialog',
  'CommandEmpty',
  'CommandFooter',
  'CommandGroup',
  'CommandInput',
  'CommandItem',
  'CommandList',
  'CommandPopover',
  'CommandPopoverContent',
  'CommandPopoverTrigger',
  'CommandSeparator',
  'CommandShortcut',
] as const;

describe('command module surface', () => {
  test('exports every component the app imports', () => {
    for (const name of SURVIVING_EXPORTS) {
      expect(name in commandModule).toBe(true);
    }
  });

  test('the popover/dialog wrappers are real components, not undefined', () => {
    // The Radix passthroughs cannot render their overlay without a live DOM,
    // so they are pinned as present-callable exports instead.
    expect(typeof commandModule.CommandDialog).toBe('function');
    expect(typeof commandModule.CommandPopover).toBe('function');
    expect(typeof commandModule.CommandPopoverContent).toBe('function');
    expect(typeof commandModule.CommandPopoverTrigger).toBe('object');
  });
});

describe('command rendering', () => {
  test('Command renders the cmdk root with the popover surface', () => {
    const html = renderToStaticMarkup(<Command />);
    expect(html).toContain('data-slot="command"');
    expect(html).toContain('bg-popover');
    expect(html).toContain('flex h-full w-full flex-col');
  });

  test('the palette composition renders input, list and item slots together', () => {
    const html = renderToStaticMarkup(
      <Command>
        <CommandInput placeholder="Search" />
        <CommandList>
          <CommandItem>Deploy project</CommandItem>
        </CommandList>
      </Command>,
    );
    expect(html).toContain('data-slot="command-input"');
    expect(html).toContain('data-slot="command-list"');
    expect(html).toContain('data-slot="command-item"');
    expect(html).toContain('Deploy project');
  });

  test('CommandItem keeps the hover fill and the pointer-mode-selected scoping', () => {
    // cmdk items subscribe to the surrounding Command store, so every item
    // assertion renders inside a root — the way the palette composes them.
    const html = renderToStaticMarkup(
      <Command>
        <CommandItem>Deploy project</CommandItem>
      </Command>,
    );
    // `hover:bg-hover` mirrors the cmdk selected state on purpose (see the
    // component comment); the scoping prefix keeps keyboard mode on
    // `data-selected` while pointer mode follows CSS :hover.
    expect(html).toContain('hover:bg-hover');
    // `renderToStaticMarkup` escapes `&` inside attributes, so the scoping
    // prefix is asserted from the first `[` on: the full selector is
    // `[&:not([data-nav=pointer]_*)]:data-[selected=true]:bg-hover`.
    expect(html).toContain(':not([data-nav=pointer]_*)]:data-[selected=true]:bg-hover');
    expect(html).toContain(':not([data-nav=pointer]_*)]:data-[selected=true]:text-foreground');
  });

  test('CommandInput compact renders the shorter wrapper', () => {
    const html = renderToStaticMarkup(
      <Command>
        <CommandInput compact />
      </Command>,
    );
    expect(html).toContain('h-11 gap-2.5 px-4');
  });

  test('CommandInput renders its left element before the field', () => {
    const html = renderToStaticMarkup(
      <Command>
        <CommandInput leftElement={<span>icon</span>} />
      </Command>,
    );
    expect(html).toContain('icon');
    expect(html.indexOf('icon')).toBeLessThan(html.indexOf('data-slot="command-input"'));
  });

  test('CommandGroup, CommandSeparator, CommandShortcut and CommandFooter render their slots', () => {
    // cmdk's `CommandEmpty` renders nothing in static markup (its empty state
    // needs registered items, which never happens without effects), so it is
    // pinned by the module-surface test above.
    const html = renderToStaticMarkup(
      <Command>
        <CommandGroup heading="Actions" />
        <CommandSeparator />
        <CommandShortcut>⌘K</CommandShortcut>
        <CommandFooter>footer</CommandFooter>
      </Command>,
    );
    expect(html).toContain('data-slot="command-group"');
    expect(html).toContain('Actions');
    expect(html).toContain('data-slot="command-separator"');
    expect(html).toContain('data-slot="command-shortcut"');
    expect(html).toContain('data-slot="command-footer"');
  });

  test('CommandDialog renders the accessible header with the palette copy', () => {
    const html = renderToStaticMarkup(
      <CommandDialog>
        <Command />
      </CommandDialog>,
    );
    expect(html).toContain('sr-only');
    expect(html).toContain('Command Palette');
  });

  test('CommandPopover passes children through', () => {
    const html = renderToStaticMarkup(
      <CommandPopover open onOpenChange={() => {}}>
        <span>row</span>
      </CommandPopover>,
    );
    expect(html).toContain('row');
  });
});

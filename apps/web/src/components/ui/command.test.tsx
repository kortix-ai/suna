import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import * as command from './command';

/**
 * Characterization tests for the command.tsx primitives. They pin the module's
 * surviving export surface and its rendered markup so a dead-export cleanup
 * (KRTX-657 removed the unreferenced hover-card and kbd helpers) cannot
 * silently change what the five real consumers import and render.
 */
const CONSUMER_EXPORTS = [
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

describe('command.tsx export surface', () => {
  test('every export a consumer imports is still defined', () => {
    for (const name of CONSUMER_EXPORTS) {
      expect(command[name], name).toBeDefined();
    }
  });
});

describe('command.tsx rendered markup', () => {
  test('Command renders items and shortcuts through cmdk', () => {
    const html = renderToStaticMarkup(
      <command.Command>
        <command.CommandItem>Open project</command.CommandItem>
        <command.CommandShortcut>⌘O</command.CommandShortcut>
      </command.Command>,
    );
    expect(html).toContain('data-slot="command"');
    expect(html).toContain('data-slot="command-item"');
    expect(html).toContain('Open project');
    expect(html).toContain('data-slot="command-shortcut"');
    expect(html).toContain('⌘O');
  });

  test('CommandList, CommandGroup and CommandSeparator keep their slots', () => {
    const html = renderToStaticMarkup(
      <command.Command>
        <command.CommandList>
          <command.CommandGroup heading="Projects">
            <command.CommandItem>Open project</command.CommandItem>
          </command.CommandGroup>
          <command.CommandSeparator />
        </command.CommandList>
      </command.Command>,
    );
    expect(html).toContain('data-slot="command-list"');
    expect(html).toContain('data-slot="command-group"');
    expect(html).toContain('Projects');
    expect(html).toContain('data-slot="command-separator"');
  });
});

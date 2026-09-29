/** Characterization: the surviving command primitives keep their data-slot + highlight contract. */
import { describe, expect, test } from 'bun:test';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Command, CommandInput, CommandItem } from './command';
describe('command primitives', () => {
  test('surviving exports render their data-slot contract', () => {
    const item = renderToStaticMarkup(h(Command, null, h(CommandItem, null, 'row')));
    const input = renderToStaticMarkup(h(Command, null, h(CommandInput, { compact: true })));
    expect(item).toContain('data-slot="command-item"');
    expect(item).toContain('hover:bg-hover');
    expect(input).toContain('data-slot="command-input"');
  });
});

/**
 * The help overlay is the app's discoverability contract: a binding that does
 * not appear here does not exist as far as a user is concerned. These tests
 * assert completeness, not pixels.
 */

import { describe, expect, test } from 'bun:test';

import { testRender } from '@opentui/react/test-utils';
import { act } from 'react';

import { allBindings } from '../../keymap.ts';
import { HelpOverlay, helpLines, sectionRule } from './help-overlay.tsx';

describe('helpLines', () => {
  const lines = helpLines();
  const bindingLines = lines.filter((line) => line.kind === 'binding');

  test('every binding in the app appears exactly once', () => {
    const printed = bindingLines.map((line) => (line.kind === 'binding' ? line.binding.id : ''));
    const expected = allBindings().map((binding) => binding.id);
    expect(printed.slice().sort()).toEqual(expected.slice().sort());
  });

  test('no id is printed twice', () => {
    const ids = bindingLines.map((line) => (line.kind === 'binding' ? line.binding.id : ''));
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('every scope that has bindings gets exactly one heading', () => {
    const headings = lines.filter((line) => line.kind === 'section');
    const scopes = new Set(allBindings().map((binding) => binding.scope));
    expect(headings.length).toBe(scopes.size);
    expect(new Set(headings.map((line) => (line.kind === 'section' ? line.scope : ''))).size).toBe(
      scopes.size,
    );
  });

  test('every binding is printed under its own scope heading', () => {
    let current = '';
    for (const line of lines) {
      if (line.kind === 'section') {
        current = line.scope;
        continue;
      }
      expect(line.binding.scope).toBe(current as typeof line.binding.scope);
    }
  });

  test('every row carries a printed chord and a description', () => {
    for (const line of bindingLines) {
      if (line.kind !== 'binding') continue;
      expect(line.keys.length).toBeGreaterThan(0);
      expect(line.binding.description.length).toBeGreaterThan(0);
    }
  });

  test('a scope with no bindings prints no heading', () => {
    const subset = helpLines(allBindings().filter((binding) => binding.scope === 'terminal'));
    expect(subset.filter((line) => line.kind === 'section').length).toBe(1);
  });
});

describe('sectionRule', () => {
  test('fills the row', () => {
    expect(sectionRule('Composer', 20)).toBe('── Composer ────────');
    expect(sectionRule('Composer', 20).length).toBe(20);
  });

  test('truncates rather than wrapping when the terminal is narrow', () => {
    expect(sectionRule('Lists, pickers and dialogs', 10).length).toBe(10);
  });
});

describe('HelpOverlay', () => {
  test('renders the first scope and scrolls to the last one', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const { renderer, captureCharFrame, mockInput, renderOnce } = await testRender(
      <HelpOverlay onClose={() => {}} />,
      { width: 100, height: 30 },
    );
    await renderOnce();
    const first = captureCharFrame();
    expect(first).toContain('Anywhere');
    expect(first).toContain('Ctrl+c / Ctrl+q');

    // The table is far taller than 30 rows, so the last scope is only
    // reachable by scrolling — which is the whole reason the overlay scrolls.
    expect(first).not.toContain('Lists, pickers and dialogs');
    // `act` is required or the state update from the key has not committed
    // when the next frame is captured (`docs/opentui-notes.md`).
    await act(async () => mockInput.pressKey('G'));
    await renderOnce();
    expect(captureCharFrame()).toContain('Lists, pickers and dialogs');
    renderer.destroy();
  });
});

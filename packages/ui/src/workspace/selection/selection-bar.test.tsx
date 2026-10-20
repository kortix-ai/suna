import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { SelectionBar, type SelectionBarAction } from './selection-bar';

const noop = () => {};
const actions: SelectionBarAction[] = [
  { id: 'approve', label: 'Approve', onSelect: noop },
  { id: 'deny', label: 'Deny', tone: 'destructive', disabled: true, onSelect: noop },
];
const bar = (props: Partial<Parameters<typeof SelectionBar>[0]> = {}) =>
  renderToStaticMarkup(
    <SelectionBar
      selectedCount={2}
      allSelected={false}
      onSelectAll={noop}
      onClear={noop}
      onExit={noop}
      actions={actions}
      {...props}
    />,
  );
// A text button reads its label; the icon-only Exit carries it as aria-label.
const button = (out: string, label: string) =>
  out.match(new RegExp(`<button(?:(?!<button).)*?(?:aria-label="${label}"[^>]*>|>${label}</button>)`))?.[0] ??
  '';

describe('SelectionBar', () => {
  test('announces the count and renders Select all, the actions and Exit in order', () => {
    const out = bar();
    expect(out).toContain('aria-live="polite"');
    expect(out).toContain('2 selected');
    expect(out).toContain('data-slot="button-group"');
    const order = ['Select all', 'Approve', 'Deny', 'Exit selection'].map((l) =>
      out.indexOf(button(out, l)),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test('actions are text buttons with no glyph', () => {
    const out = bar();
    expect(button(out, 'Approve')).not.toContain('<svg');
    expect(button(out, 'Select all')).not.toContain('<svg');
  });

  test('a disabled action is disabled; a destructive action takes the destructive tone', () => {
    const out = bar();
    expect(button(out, 'Approve')).not.toContain('disabled=""');
    expect(button(out, 'Deny')).toContain('disabled=""');
    expect(button(out, 'Deny')).toContain('text-destructive');
    expect(button(out, 'Approve')).not.toContain('text-destructive');
  });

  test('all selected turns Select all into Clear; canSelectAll=false disables it', () => {
    expect(button(bar({ allSelected: true }), 'Clear')).not.toBe('');
    expect(button(bar({ canSelectAll: false }), 'Select all')).toContain('disabled=""');
  });

  test('enters from a faded 8px rise; animateIn=false paints at rest', () => {
    const root = (out: string) => out.match(/^<div[^>]*>/)?.[0] ?? '';
    expect(root(bar())).toContain('opacity:0;transform:translateY(8px)');
    expect(root(bar({ animateIn: false }))).toContain('opacity:1;transform:translateY(0px)');
  });

  test('progress replaces the count and disables every control, Exit included', () => {
    const out = bar({ progress: { label: 'Approving 1 of 2…', done: 1, total: 2 } });
    expect(out).toContain('Approving 1 of 2…');
    expect(out).not.toContain('2 selected');
    for (const l of ['Select all', 'Approve', 'Exit selection']) {
      expect(button(out, l)).toContain('disabled=""');
    }
  });
});

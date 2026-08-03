import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { CostSortHeader, type CostSortDirection } from './cost-sort-header';
import { collectElementsByType } from './react-element-tree';

const noop = () => {};

function render(props: Partial<Parameters<typeof CostSortHeader>[0]> = {}): string {
  return renderToStaticMarkup(<CostSortHeader label="Total" onSort={noop} {...props} />);
}

// ── aria-sort ──────────────────────────────────────────────────────────────
//
// The only thing that tells assistive technology which column is ordering the
// table. It belongs on the active column and nowhere else — `aria-sort="none"`
// on the inactive ones would announce every sortable column as participating,
// which is the opposite of what it is for.

describe('CostSortHeader aria-sort', () => {
  test('carries the active direction', () => {
    expect(render({ direction: 'descending' })).toContain('aria-sort="descending"');
    expect(render({ direction: 'ascending' })).toContain('aria-sort="ascending"');
  });

  test('is absent entirely on an inactive column, not "none"', () => {
    const html = render({ direction: undefined });
    expect(html).not.toContain('aria-sort');
  });

  test('sits on the <th>, where assistive technology looks for it — not on the button', () => {
    const html = render({ direction: 'descending' });
    const th = html.match(/<th[^>]*>/)![0];
    expect(th).toContain('aria-sort="descending"');
    expect(html.match(/<button[^>]*>/)![0]).not.toContain('aria-sort');
  });
});

// ── Keyboard reachability ──────────────────────────────────────────────────
//
// A click handler on the `<th>` would be a mouse-only control: a `<th>` is not
// focusable, gets no Enter/Space activation, and cannot take a focus ring. The
// control has to be a real button inside the cell.

describe('CostSortHeader keyboard access', () => {
  test('the control is a real button inside the th', () => {
    const html = render();
    expect(html).toMatch(/<th[^>]*>\s*<button/);
    expect(html).toContain('type="button"');
  });

  test('the button carries a visible focus ring', () => {
    const button = render().match(/<button[^>]*>/)![0];
    expect(button).toContain('focus-visible:ring-2');
    expect(button).toContain('focus-visible:ring-ring/50');
    // `outline-none` without a replacement ring is the accessibility defect
    // this pairs against — the ring above is the replacement.
    expect(button).toContain('outline-none');
  });

  test('calls onSort when activated', () => {
    let calls = 0;
    const tree = CostSortHeader({ label: 'Total', onSort: () => (calls += 1) });
    const buttons = collectElementsByType(tree, 'button');
    expect(buttons).toHaveLength(1);
    (buttons[0]!.props.onClick as () => void)();
    expect(calls).toBe(1);
  });
});

// ── The direction indicator ────────────────────────────────────────────────

describe('CostSortHeader indicator', () => {
  test('the active column shows a direction glyph', () => {
    expect(render({ direction: 'ascending' })).toContain('<svg');
    expect(render({ direction: 'descending' })).toContain('<svg');
  });

  // The two directions must not render the same glyph, or the indicator says
  // "this column is sorted" without saying which way.
  test('ascending and descending render different glyphs', () => {
    const ascending = render({ direction: 'ascending' }).match(/<path[^>]*d="([^"]*)"/)![1];
    const descending = render({ direction: 'descending' }).match(/<path[^>]*d="([^"]*)"/)![1];
    expect(ascending).not.toBe(descending);
  });

  // A sortable-but-inactive column needs an affordance, revealed on hover and
  // on keyboard focus. The focus half is not optional: Tailwind v4 scopes
  // `hover:` to `@media (hover: hover)`, so a hover-only affordance does not
  // exist for keyboard or touch users at all.
  test('an inactive column carries a muted affordance for hover and focus', () => {
    const html = render({ direction: undefined });
    const icon = html.match(/<svg[^>]*class="([^"]*)"/)![1]!;
    expect(icon).toContain('opacity-0');
    expect(icon).toContain('group-hover/sort:opacity-60');
    expect(icon).toContain('group-focus-visible/sort:opacity-60');
  });

  // The indicator box is occupied in BOTH states, so activating a sort does
  // not shift the header label sideways by the width of an icon.
  test('the indicator box is reserved whether or not the column is active', () => {
    for (const direction of [undefined, 'ascending', 'descending'] as (
      | CostSortDirection
      | undefined
    )[]) {
      const html = render({ direction });
      expect((html.match(/<svg/g) ?? []).length, `direction ${direction}`).toBe(1);
    }
  });

  test('the glyph is hidden from assistive technology — aria-sort already says it', () => {
    for (const direction of [undefined, 'ascending', 'descending'] as (
      | CostSortDirection
      | undefined
    )[]) {
      expect(render({ direction })).toMatch(/<svg[^>]*aria-hidden="true"/);
    }
  });
});

// ── Alignment ──────────────────────────────────────────────────────────────
//
// Money columns are right-aligned so the digits line up. The header has to
// keep that, and the indicator has to sit inside the alignment rather than
// being floated out of the flow.

describe('CostSortHeader alignment', () => {
  test('defaults to left, matching a text column', () => {
    const html = render();
    expect(html.match(/<th[^>]*>/)![0]).not.toContain('text-right');
    expect(html.match(/<button[^>]*>/)![0]).not.toContain('flex-row-reverse');
  });

  test('a right-aligned column keeps its alignment on the cell', () => {
    expect(render({ align: 'right' }).match(/<th[^>]*>/)![0]).toContain('text-right');
  });

  // The indicator moves to the inboard side, so the LABEL's right edge stays
  // flush with the numbers below it. Reversing the flex direction keeps the
  // icon in the cell's own alignment; floating it would take it out of flow.
  test('the indicator sits inboard of the label, not floated', () => {
    const button = render({ align: 'right', direction: 'descending' }).match(/<button[^>]*>/)![0];
    expect(button).toContain('flex-row-reverse');
    expect(button).not.toContain('float');
    expect(button).not.toContain('absolute');
  });
});

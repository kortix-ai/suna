import { describe, expect, test } from 'bun:test';
import { triggerVariants } from './trigger-variants';

describe('triggerVariants', () => {
  const cls = triggerVariants();

  test('a trigger child keeps its own display, so an icon + label row stays one row', () => {
    // `line-clamp-1` sets `display: -webkit-box` on every direct <span> and
    // out-ranks the child's `flex`: the /new repository picker rendered its
    // GitHub icon ABOVE "Search repositories". `truncate` only sets overflow.
    expect(cls).not.toContain('line-clamp');
    expect(cls).toContain('[&>span]:truncate');
    expect(cls).toContain('[&>span]:min-w-0');
  });

  test('a form-field trigger does not shrink on press; only the toolbar trigger does', () => {
    expect(triggerVariants({ variant: 'secondary' })).not.toContain('scale');
    expect(triggerVariants({ variant: 'outline' })).not.toContain('scale');
    expect(triggerVariants({ variant: 'transparent' })).toContain('active:scale-[0.98]');
  });
});

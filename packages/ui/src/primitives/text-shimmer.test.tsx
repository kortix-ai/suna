import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

import { TextShimmer } from './text-shimmer';

const source = readFileSync(join(import.meta.dir, 'text-shimmer.tsx'), 'utf8');

const render = (props: Partial<React.ComponentProps<typeof TextShimmer>> & { children: string }) =>
  renderToStaticMarkup(<TextShimmer {...props} />);

describe('TextShimmer', () => {
  test('renders its text', () => {
    const html = render({ children: 'Thinking' });
    expect(html).toContain('Thinking');
  });

  test('keeps the gradient-clip signature every caller depends on', () => {
    // `workspace-handoff.test.tsx`, `activity-burst.test.tsx`,
    // `activity-file-chips.test.tsx`, `optimistic-turn.test.tsx` and
    // `session-busy-indicator.test.tsx` all fingerprint the shimmer by these
    // two classes — losing either makes the caption invisible, not merely
    // unanimated.
    const html = render({ children: 'Thinking' });
    expect(html).toContain('bg-clip-text');
    expect(html).toContain('text-transparent');
  });

  test('this file no longer drives the sweep from JS', () => {
    // The regression this whole change fixes: a per-frame `motion/react`
    // `animate={{ backgroundPosition }}` loop running for as long as the
    // shimmer is mounted. `m.create` remounted the subtree whenever `as`
    // changed identity, too — gone along with the import.
    expect(source).not.toContain("from 'motion/react'");
    // The invocation, not just the substring — the file's own comments now
    // reference `m.create` by name to explain why it is gone.
    expect(source).not.toContain('m.create(');
  });

  test('the sweep is a real CSS animation, not a static background', () => {
    const html = render({ children: 'Thinking' });
    expect(html).toContain('@keyframes kx-shimmer-sweep');
    expect(html).toContain('animation-name:kx-shimmer-sweep-hold');
    expect(html).toContain('animation-timing-function:linear');
  });

  test('repeat=Infinity (the default every real caller uses) loops forever', () => {
    const html = render({ children: 'Thinking' });
    expect(html).toContain('animation-iteration-count:infinite');
    expect(html).toContain('animation-name:kx-shimmer-sweep-hold');
    expect(html).not.toContain('animation-name:kx-shimmer-sweep;');
  });

  test('repeat=1 plays once and holds the end state — no infinite loop, no pause keyframe', () => {
    const html = render({ children: 'Thinking', repeat: 1 });
    expect(html).toContain('animation-iteration-count:1');
    expect(html).toContain('animation-fill-mode:forwards');
    // The bare sweep keyframe, not the sweep-then-hold one used for the
    // infinite case.
    expect(html).toMatch(/animation-name:kx-shimmer-sweep(?!-hold)/);
  });

  test('duration is honored: the infinite case runs the sweep for exactly `duration` seconds', () => {
    // `kx-shimmer-sweep-hold` finishes its sweep at the 80% keyframe mark, so
    // an `animation-duration` of `duration / 0.8` puts the sweep itself at
    // `duration` seconds (0.8 * (duration / 0.8) = duration) and leaves the
    // trailing 20% as a hold that scales with it.
    const html = render({ children: 'x', duration: 1 });
    expect(html).toContain('animation-duration:1.25s');
  });

  test('a finite repeat runs the animation for exactly `duration` seconds — no hold added', () => {
    const html = render({ children: 'x', duration: 1, repeat: 3 });
    expect(html).toContain('animation-duration:1s');
    expect(html).toContain('animation-iteration-count:3');
  });

  test('spread scales with the text length, matching the old contract', () => {
    // `dynamicSpread = children.length * spread` is unchanged from the
    // Motion version.
    const short = render({ children: 'Hi', spread: 2 });
    const long = render({ children: 'Hello there', spread: 2 });
    expect(short).toContain('--spread:4px');
    expect(long).toContain('--spread:22px');
  });

  test('reduced motion drops the animation and falls back to a static base color', () => {
    const html = render({ children: 'Thinking' });
    expect(html).toContain('prefers-reduced-motion: reduce');
    expect(html).toContain('animation: none !important');
    expect(html).toContain('color: var(--base-color) !important');
  });

  test('`as` still swaps the rendered element, without a Motion-only component wrapper', () => {
    const spanHtml = render({ children: 'x' });
    expect(spanHtml.startsWith('<span')).toBe(true);

    const divHtml = render({ children: 'x', as: 'div' });
    expect(divHtml.startsWith('<div')).toBe(true);
  });

  test('className merges in alongside the shimmer classes', () => {
    const html = render({ children: 'x', className: 'italic' });
    expect(html).toContain('italic');
    expect(html).toContain('bg-clip-text');
  });
});

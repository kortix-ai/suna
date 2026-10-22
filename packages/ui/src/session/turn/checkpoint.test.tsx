/**
 * Characterization for the surviving checkpoint primitives, written before the
 * unreferenced `CheckpointTrigger` was removed. `compaction-card.tsx` composes
 * `Checkpoint`/`CheckpointIcon`/`CheckpointLabel` into the session's compaction
 * rows; these tests pin that composition surface.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'bun:test';

import { createElement } from 'react';
import { Checkpoint, CheckpointIcon, CheckpointLabel } from './checkpoint';

describe('Checkpoint', () => {
  test('renders children followed by a growing separator', () => {
    const html = renderToStaticMarkup(
      createElement(Checkpoint, null, createElement('span', null, 'Interrupted')),
    );
    expect(html).toContain('flex items-center gap-0.5 overflow-hidden');
    expect(html).toContain('shrink grow basis-0');
    expect(html).toContain('Interrupted');
  });

  test('passes through className and DOM props', () => {
    const html = renderToStaticMarkup(
      createElement(Checkpoint, { className: 'extra', title: 'hint' }),
    );
    expect(html).toContain('extra');
    expect(html).toContain('title="hint"');
  });
});

describe('CheckpointIcon', () => {
  test('falls back to the bookmark glyph when no children are given', () => {
    const html = renderToStaticMarkup(createElement(CheckpointIcon));
    expect(html).toContain('size-4 shrink-0');
  });

  test('renders the given children instead of the glyph', () => {
    const html = renderToStaticMarkup(
      createElement(CheckpointIcon, null, createElement('b', null, 'x')),
    );
    expect(html).toContain('<b>x</b>');
    expect(html).not.toContain('size-4 shrink-0');
  });
});

describe('CheckpointLabel', () => {
  test('truncates and keeps the non-clickable default cursor', () => {
    const html = renderToStaticMarkup(createElement(CheckpointLabel, null, 'Compacted'));
    expect(html).toContain('cursor-default truncate');
    expect(html).toContain('Compacted');
  });
});

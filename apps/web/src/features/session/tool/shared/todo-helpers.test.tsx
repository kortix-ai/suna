import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { STATUS_RING, STATUS_RING_OUTER_RADIUS } from '@/components/ui/status-ring';

import { TodoStatusIcon, parseTodos, type TodoItem } from './todo-helpers';

const STATUSES: TodoItem['status'][] = ['pending', 'in_progress', 'completed', 'cancelled'];

const render = (status: TodoItem['status'], className?: string) =>
  renderToStaticMarkup(<TodoStatusIcon status={status} className={className} />);

describe('parseTodos', () => {
  test('keeps well-formed todos and normalises an unknown status to pending', () => {
    expect(
      parseTodos([
        { content: 'a', status: 'completed' },
        { content: 'b', status: 'wat' },
        { content: 'c' },
      ]),
    ).toEqual([
      { content: 'a', status: 'completed', priority: undefined },
      { content: 'b', status: 'pending', priority: undefined },
      { content: 'c', status: 'pending', priority: undefined },
    ]);
  });

  test('drops anything without usable content, and never throws on junk', () => {
    expect(parseTodos([null, 7, {}, { content: '   ' }, 'nope'])).toEqual([]);
    expect(parseTodos(undefined)).toEqual([]);
    expect(parseTodos({ content: 'not an array' })).toEqual([]);
  });
});

/**
 * The four states used to live in three coordinate systems — all nominally
 * `size-4`, all painting a different disc at a different stroke weight (the
 * numbers are in `status-ring.ts`). The check read small and the spinner read
 * fat, and no `size-*` tuning could fix it because the mismatch was inside each
 * glyph's own viewBox.
 *
 * These tests pin the fix. They are geometry assertions rather than snapshots on
 * purpose: a snapshot would go green on any consistent redraw, including one
 * that quietly re-introduces the mismatch.
 */
describe('TodoStatusIcon — one silhouette, four meanings', () => {
  test('every state is drawn on the shared 16-unit grid', () => {
    for (const status of STATUSES) {
      expect(render(status)).toContain(`viewBox="0 0 ${STATUS_RING.BOX} ${STATUS_RING.BOX}"`);
    }
  });

  test('every state paints the same outer circle', () => {
    // Ring states stop at the centreline + half the stroke; filled states use
    // that same edge as their radius. Both land on a 14.1-unit disc.
    const ringStates = ['pending', 'in_progress'] as const;
    for (const status of ringStates) {
      const markup = render(status);
      expect(markup).toContain(`r="${STATUS_RING.RADIUS}"`);
      expect(markup).toContain(`stroke-width="${STATUS_RING.STROKE}"`);
    }

    const filledStates = ['completed', 'cancelled'] as const;
    for (const status of filledStates) {
      expect(render(status)).toContain(`r="${STATUS_RING_OUTER_RADIUS}"`);
    }

    expect(STATUS_RING_OUTER_RADIUS * 2).toBe(14.1);
  });

  test('no state smuggles in a foreign viewBox or a heavier stroke', () => {
    for (const status of STATUSES) {
      const markup = render(status);
      // 24 was the spinner's box, 256 was Phosphor's.
      expect(markup).not.toContain('viewBox="0 0 24 24"');
      expect(markup).not.toContain('viewBox="0 0 256 256"');
      // 4 was the spinner's stroke — 2.67px at size-4 against the ring's 1.5px.
      expect(markup).not.toContain('stroke-width="4"');
    }
  });

  test('every state defaults to size-4 and lets a caller resize the whole family', () => {
    for (const status of STATUSES) {
      expect(render(status)).toContain('size-4');
      // The root <svg> carries NO intrinsic width/height, so the class is the
      // only size — which is what lets `plan-card.tsx` grow the whole rail to
      // 18px with one string. (The inner <mask> keeps its own userSpace bounds;
      // those are viewBox units, not a rendered size.)
      const grown = render(status, 'size-[18px]');
      expect(grown).toContain('size-[18px]');
      expect(grown).not.toContain('size-4');
      const root = grown.slice(0, grown.indexOf('>') + 1);
      expect(root).toStartWith('<svg');
      expect(root).not.toMatch(/\swidth=/);
      expect(root).not.toMatch(/\sheight=/);
    }
  });

  test('each state carries its own token, and never a raw palette colour', () => {
    expect(render('completed')).toContain('text-kortix-green');
    expect(render('in_progress')).toContain('text-kortix-orange');
    expect(render('pending')).toContain('text-muted-foreground');
    expect(render('cancelled')).toContain('text-muted-foreground/40');
    for (const status of STATUSES) {
      expect(render(status)).not.toMatch(/text-(emerald|amber|green|red|slate|zinc)-\d/);
    }
  });

  test('the check is knocked OUT of the disc, so it shows the surface behind it', () => {
    // A `--background`-coloured stroke would be wrong on a hovered row, a
    // selected row, or any tinted surface. A mask is right everywhere.
    const markup = render('completed');
    expect(markup).toContain('<mask');
    expect(markup).toContain('mask="url(#');
    expect(markup).not.toContain('var(--background)');
  });

  test('two glyphs on one page do not collide on the mask id', () => {
    const markup = renderToStaticMarkup(
      <>
        <TodoStatusIcon status="completed" />
        <TodoStatusIcon status="cancelled" />
      </>,
    );
    const ids = [...markup.matchAll(/<mask id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    // `useId` emits colons; legal in an id, hostile inside `url(#…)`.
    for (const id of ids) expect(id).not.toContain(':');
  });

  test('the running state is the spinner component, not a hand-rolled one', () => {
    // The design system allows exactly one spinner. `variant="ring"` is that
    // component wearing this geometry.
    expect(render('in_progress')).toContain('animate-spinner-dash');
  });
});

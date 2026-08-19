/**
 * The detail sheet must have exactly ONE scrolling surface, and the class that
 * makes it scroll must survive `cn()`.
 *
 * Two separate bugs made this sheet unscrollable, and both are easy to
 * reintroduce because both look correct in the source:
 *
 * 1. **A nested scroller.** The copyable value block carried
 *    `max-h-40 overflow-auto`, so a long webhook URL became its own scroll box
 *    inside a sheet that also scrolled. The wheel then goes to whichever
 *    surface the cursor is over, and the sheet reads as stuck.
 *
 * 2. **twMerge does not dedupe `overflow-hidden` against `overflow-y-auto`.**
 *    They are different utility groups, so `cn(base, className)` emits BOTH,
 *    and `overflow: hidden` from `sheetVariants` still clamps the y axis. The
 *    `!` on `!overflow-y-auto` is what settles it. Someone will eventually read
 *    that `!` as noise — this test is why they should not remove it.
 *
 * Asserted against the SOURCE because the sheet needs a live QueryClient and a
 * Radix portal, and apps/web has no DOM testing library. Comments are stripped
 * first: the file documents `!overflow-y-auto` in prose right above the prop,
 * so matching raw source would pass with the real code deleted — a trap this
 * codebase has already fallen into once.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const RAW = readFileSync(join(import.meta.dir, 'schedule-detail-sheet.tsx'), 'utf8');
const SRC = RAW.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const FIELDS = readFileSync(join(import.meta.dir, 'schedule-fields.tsx'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

describe('schedule detail sheet scrolling', () => {
  test('the sheet content is the scroller, with the important flag intact', () => {
    expect(SRC).toContain('!overflow-y-auto');
  });

  test('comments are stripped — otherwise the prose above the prop satisfies this', () => {
    // Guards the stripping itself. The header comment explains the `!`, so a
    // raw-source match would hold even with the prop deleted.
    expect(RAW).toContain('load-bearing');
    expect(SRC).not.toContain('load-bearing');
  });

  test('SheetBody is not a second scroller', () => {
    const body = SRC.match(/<SheetBody[^>]*>/)?.[0] ?? '';
    expect(body).not.toContain('overflow-y-auto');
    expect(body).not.toContain('overflow-auto');
  });

  test('the copyable value block does not scroll vertically', () => {
    // Horizontal is fine — long URLs need it. A vertical cap is what turned
    // this into a nested scroll box.
    expect(FIELDS).not.toContain('max-h-40 overflow-auto');
    expect(FIELDS).toContain('overflow-x-auto');
  });

  test('the header stays put while the content scrolls', () => {
    // With the content element scrolling, a non-sticky header would carry the
    // Run now / Pause actions off screen.
    const header = SRC.match(/<SheetHeader[^>]*>/)?.[0] ?? '';
    expect(header).toContain('sticky');
    expect(header).toContain('top-0');
  });
});

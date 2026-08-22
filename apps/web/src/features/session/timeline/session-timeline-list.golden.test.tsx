import { freezeClock, restoreClock } from './__fixtures__/clock';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { __testing as shiki } from '@/components/markdown/code/shiki-highlighter';

import { normalizeMarkup, renderWithProviders } from './__fixtures__/render';
import { ScenarioList } from './__fixtures__/render-list';
import { scenarios } from './__fixtures__/transcript';

/**
 * The golden was captured in a FRESH process, where the shell-mode bash block
 * renders its cold (un-highlighted) markup: `highlightSync` has no cached HTML
 * and no loaded language yet. `bun test` runs every file of a directory in one
 * process, so an earlier test can leave the highlighter warm and flip that
 * block to its highlighted markup. Render cold, every time.
 */
function renderCold(element: React.ReactElement): string {
  shiki.shikiCache.clear();
  shiki.loadedLangs.clear();
  return normalizeMarkup(renderWithProviders(element));
}

/**
 * The golden was captured ONCE from the LEGACY turn list —
 * `turns.map(TurnViewport > [CompactionDivider] > SessionTurn)` in
 * `session-chat.tsx` — by `__fixtures__/capture-golden.legacy.tsx` on the
 * pre-refactor tree, under the same clock, providers and `useId`
 * normalization (`__fixtures__/render.tsx`), and re-captured once more on the
 * last legacy tree before this list landed (e2f626e4c3, main's
 * `max-md:opacity-100` turn-actions bar included). `SessionTimelineList` has
 * to reproduce it byte for byte: same tags, attributes, classes and text, in
 * the same order. The `INTENDED_DIVERGENCES` of `build-chat-rows.test.ts` are
 * the only goldens taken from the new render instead.
 */
const golden = (name: string) =>
  readFileSync(
    fileURLToPath(new URL(`./__fixtures__/golden.${name}.html`, import.meta.url)),
    'utf8',
  );

/** The first point where two strings differ, with context — a diff you can read. */
function firstDifference(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const from = Math.max(0, i - 200);
  return `at ${i}\n--- golden\n${a.slice(from, i + 200)}\n--- actual\n${b.slice(from, i + 200)}`;
}

describe('SessionTimelineList reproduces the legacy turn list', () => {
  beforeAll(freezeClock);
  afterAll(restoreClock);

  for (const scenario of scenarios) {
    test(`${scenario.name} scenario renders the golden markup`, () => {
      const expected = golden(scenario.name);
      const actual = renderCold(<ScenarioList scenario={scenario} />);
      if (actual !== expected) {
        throw new Error(firstDifference(expected, actual));
      }
      expect(actual).toBe(expected);
    });
  }

  test('the scroll-anchor attributes keep their count and nesting', () => {
    // `use-auto-scroll.ts` anchors on the last `[data-turn-id]` WITHOUT a
    // `[data-turn-pending]` descendant; `session-history-scroll.ts` and the
    // minimap query `[data-turn-id]`. Every pending marker must therefore sit
    // INSIDE a turn element. Asserted on the markup, on both sides.
    for (const scenario of scenarios) {
      const actual = renderCold(<ScenarioList scenario={scenario} />);
      const expected = golden(scenario.name);
      const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;
      expect(count(actual, /data-turn-id="/g)).toBe(count(expected, /data-turn-id="/g));
      expect(count(actual, /data-turn-pending="true"/g)).toBe(
        count(expected, /data-turn-pending="true"/g),
      );
      expect(count(actual, /data-turn-queue-state="/g)).toBe(
        count(expected, /data-turn-queue-state="/g),
      );
      // Nesting: split the markup on turn elements; every pending marker must
      // fall inside a chunk that opened with a `data-turn-id`.
      const chunks = actual.split(/(?=<div data-turn-id=")/g);
      expect(chunks[0]).not.toContain('data-turn-pending');
      const pendingChunks = chunks.filter((c) => c.includes('data-turn-pending="true"'));
      for (const chunk of pendingChunks) expect(chunk.startsWith('<div data-turn-id="')).toBe(true);
    }
    const working = renderCold(
      <ScenarioList scenario={scenarios.find((s) => s.name === 'working')!} />,
    );
    expect((working.match(/data-turn-pending="true"/g) ?? []).length).toBe(2);
    expect((working.match(/data-turn-id="/g) ?? []).length).toBe(4);
  });
});

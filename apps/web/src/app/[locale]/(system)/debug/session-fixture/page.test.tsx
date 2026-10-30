import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import SessionFixturePage from './page';
import { fixtureTurns } from './seed';

/** `data-turn-id` → whether that row carries `data-turn-continues`. */
function rowContinues(html: string): Map<string, boolean> {
  const rows = new Map<string, boolean>();
  for (const [tag] of html.matchAll(/<div[^>]*data-turn-id="[^"]*"[^>]*>/g)) {
    const id = /data-turn-id="([^"]*)"/.exec(tag)![1];
    rows.set(id, tag.includes('data-turn-continues'));
  }
  return rows;
}

describe('/debug/session-fixture page', () => {
  // KRTX-2596: the page exists for parity with the real transcript, which marks
  // a compaction and the work after it as continuing the turn above.
  test('marks the same turns as continuing as the real transcript does', () => {
    const expected = new Map(
      fixtureTurns().map((turn) => [turn.id, turn.compaction !== null || turn.continues !== null]),
    );
    expect([...expected.values()].some(Boolean)).toBe(true);
    expect(rowContinues(renderToStaticMarkup(<SessionFixturePage />))).toEqual(expected);
  });
});

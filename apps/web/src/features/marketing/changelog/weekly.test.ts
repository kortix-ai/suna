import { describe, expect, test } from 'bun:test';

import {
  groupByWeek,
  isClosed,
  isoWeekId,
  parseSections,
  pickHighlights,
  splitLead,
  weekSlug,
  weekWindow,
} from './weekly';

describe('isoWeekId', () => {
  test('boundary: Monday 00:00:00.000Z starts the new week', () => {
    expect(isoWeekId(new Date('2026-10-18T23:59:59.999Z'))).toBe('2026-W42');
    expect(isoWeekId(new Date('2026-10-19T00:00:00.000Z'))).toBe('2026-W43');
  });

  test('iso year boundaries', () => {
    expect(isoWeekId(new Date('2026-12-31T12:00:00Z'))).toBe('2026-W53');
    expect(isoWeekId(new Date('2027-01-04T00:00:00Z'))).toBe('2027-W01');
    expect(isoWeekId(new Date('2021-01-03T12:00:00Z'))).toBe('2020-W53');
  });
});

describe('weekWindow', () => {
  test('round-trips and rejects bad ids', () => {
    const w = weekWindow('2026-W42');
    expect(w.start.toISOString()).toBe('2026-10-12T00:00:00.000Z');
    expect(w.end.toISOString()).toBe('2026-10-19T00:00:00.000Z');
    expect(weekWindow('2020-W53').start.toISOString()).toBe('2020-12-28T00:00:00.000Z');
    expect(() => weekWindow('2025-W53')).toThrow('invalid week id: 2025-W53');
    expect(() => weekWindow('2026-W00')).toThrow('invalid week id: 2026-W00');
    expect(() => weekWindow('2026-42')).toThrow('invalid week id: 2026-42');
  });
});

describe('groupByWeek', () => {
  test('uses published_at; real W42/W43 split', () => {
    const rel = (tag: string, published_at: string | null) => ({ tag_name: tag, published_at });
    const groups = groupByWeek([
      rel('v0.13.56', '2026-10-12T05:27:53Z'),
      rel('v0.14.2', '2026-10-19T04:39:29Z'),
      rel('v0.14.0', '2026-10-16T22:26:00Z'),
      rel('v0.14.1', '2026-10-17T18:02:33Z'),
      rel('v0.13.57', '2026-10-14T09:19:59Z'),
      rel('vX', null),
    ]);
    expect(groups.map((g) => g.window.id)).toEqual(['2026-W43', '2026-W42']);
    expect(groups[0].releases.map((r) => r.tag_name)).toEqual(['v0.14.2']);
    expect(groups[1].releases.map((r) => r.tag_name)).toEqual([
      'v0.14.1',
      'v0.14.0',
      'v0.13.57',
      'v0.13.56',
    ]);
  });
});

test('isClosed waits 6 h after the week ends', () => {
  const w = weekWindow('2026-W42');
  expect(isClosed(w, new Date('2026-10-19T05:59:59Z'))).toBe(false);
  expect(isClosed(w, new Date('2026-10-19T06:00:00Z'))).toBe(true);
});

describe('parseSections', () => {
  const empty = { new: [], improved: [], fixed: [] };

  test("reads New/Improved/Fixed and stops at What's Changed", () => {
    const s = parseSections(
      "### New\n- **A.** one\n- B\n\n### Improved\n- C\n\n### Fixed\n- D\n\n## What's Changed\n* feat: x by @y in https://github.com/kortix-ai/suna/pull/1\n",
    );
    expect(s).toEqual({ new: ['**A.** one', 'B'], improved: ['C'], fixed: ['D'] });
  });

  test('older releases use ## headings', () => {
    const s = parseSections("## New\n- A\n\n## Fixed\n- B\n\n## What's Changed\n* x\n");
    expect(s).toEqual({ new: ['A'], improved: [], fixed: ['B'] });
  });

  test('v0.12 releases use **New** headings', () => {
    const s = parseSections('**New**\n- A\n\n**Improved**\n- B\n\n**Fixed**\n- C\n');
    expect(s).toEqual({ new: ['A'], improved: ['B'], fixed: ['C'] });
  });

  test('blank line after heading and CRLF', () => {
    expect(parseSections('### New\r\n\r\n- A\r\n- B\r\n').new).toEqual(['A', 'B']);
  });

  test('no sections → all empty; null body → all empty', () => {
    expect(parseSections("## What's Changed\n* feat: x\n")).toEqual(empty);
    expect(parseSections(null)).toEqual(empty);
  });

  test('indented continuation lines join their bullet', () => {
    expect(parseSections('### Fixed\n- first line\n  second line\n- next\n').fixed).toEqual([
      'first line second line',
      'next',
    ]);
  });
});

describe('splitLead', () => {
  test('bold lead becomes the title, the rest the body', () => {
    expect(splitLead('**One credits plan.** Every account is on Free.')).toEqual({
      title: 'One credits plan',
      body: 'Every account is on Free.',
    });
    expect(splitLead('**Desktop:** the Dock counts turns.')).toEqual({
      title: 'Desktop',
      body: 'the Dock counts turns.',
    });
  });

  test('bold lead that runs into the sentence keeps it whole', () => {
    expect(splitLead('**Pin and archive sessions** to keep your list in order.')).toEqual({
      title: null,
      body: '**Pin and archive sessions** to keep your list in order.',
    });
  });

  test('a bold lead with nothing after it is the title alone', () => {
    expect(splitLead('**Kortix as an MCP server.**')).toEqual({
      title: 'Kortix as an MCP server',
      body: '',
    });
  });

  test('plain bullet has no title', () => {
    expect(splitLead('YAML files preview again.')).toEqual({
      title: null,
      body: 'YAML files preview again.',
    });
  });
});

describe('pickHighlights', () => {
  test('round-robins bold-led items, biggest release first, capped at 5', () => {
    const big = ['**A1.** a', '**A2.** a', 'plain', '**A3.** a', '**A4.** a'];
    const small = ['**B1.** b', '**B2.** b'];
    const plainOnly = ['C1 plain'];
    // Release order is newest first; `big` has the most New items, so it leads.
    expect(pickHighlights([small, big, plainOnly])).toEqual([
      '**A1.** a',
      '**B1.** b',
      'C1 plain',
      '**A2.** a',
      '**B2.** b',
    ]);
  });

  test('ties keep newest-first order; fewer items than the cap returns them all', () => {
    expect(pickHighlights([['**N.** n'], ['**O.** o']])).toEqual(['**N.** n', '**O.** o']);
    expect(pickHighlights([[], []])).toEqual([]);
  });
});

describe('weekSlug', () => {
  test("is the week's Monday, across ISO year boundaries", () => {
    expect(weekSlug(weekWindow('2026-W43'))).toBe('2026-10-19');
    expect(weekSlug(weekWindow('2026-W53'))).toBe('2026-12-28');
    expect(weekSlug(weekWindow('2020-W53'))).toBe('2020-12-28');
    expect(weekSlug(weekWindow('2027-W01'))).toBe('2027-01-04');
  });
});

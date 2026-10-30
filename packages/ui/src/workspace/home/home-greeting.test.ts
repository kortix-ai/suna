import { describe, expect, test } from 'bun:test';

import { HOME_GREETINGS, greetingIndexFor, spaceBefore } from './home-greeting';

describe('home greeting rotation', () => {
  test('a first visit, or an unreadable counter, shows the first line', () => {
    expect(greetingIndexFor(null)).toBe(0);
    expect(greetingIndexFor('')).toBe(0);
    expect(greetingIndexFor('nope')).toBe(0);
    expect(greetingIndexFor('-3')).toBe(0);
  });

  test('visits walk every variant before any repeats', () => {
    const seen = Array.from({ length: HOME_GREETINGS.length }, (_, n) =>
      greetingIndexFor(String(n)),
    );
    expect(new Set(seen).size).toBe(HOME_GREETINGS.length);
    expect(greetingIndexFor(String(HOME_GREETINGS.length))).toBe(0);
  });

  test('every variant keeps the name in the middle of one sentence', () => {
    for (const g of HOME_GREETINGS) {
      expect(g.before.trim().length).toBeGreaterThan(0);
      expect(g.after.trim().length).toBeGreaterThan(0);
      expect(g.before).not.toMatch(/\s$/);
      expect(g.after).not.toMatch(/^\s/);
      expect(g.after).toMatch(/[.?]$/);
    }
  });

  test('every variant reads with a PROJECT name in the slot', () => {
    // The slot holds a project ("Website relaunch"), never a person, so no
    // line may address the name as someone who does things for you.
    const rendered = HOME_GREETINGS.map(
      (g) => `${g.before} Website relaunch${spaceBefore(g.after) ? ' ' : ''}${g.after}`,
    );
    expect(rendered).toContain("What's next for Website relaunch?");
    for (const line of rendered) {
      expect(line).not.toMatch(/\s[?.!,]/);
      expect(line).not.toMatch(/your plate|take off|tell .* what/i);
    }
  });

  test('bare punctuation closes the sentence without a space', () => {
    expect(spaceBefore('?')).toBe(false);
    expect(spaceBefore('forward.')).toBe(true);
  });
});

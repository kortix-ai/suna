import { describe, expect, test } from 'bun:test';

import {
  AT_END_PX,
  BOTTOM_GAP_PX,
  CHEVRON_PX,
  TURN_TOP_OFFSET,
  chevronVisible,
  classifyScrollKey,
  isAtEnd,
  isEditableTarget,
  keyScrollIntentFor,
  roomUnderNewestTurn,
} from './use-auto-scroll';

describe('roomUnderNewestTurn — FACT 1, the room is one value streaming or idle', () => {
  test('enough room for the anchor turn to sit at TURN_TOP_OFFSET', () => {
    expect(roomUnderNewestTurn(800, 100)).toBe(800 - 100 - TURN_TOP_OFFSET);
  });
  test('floored at BOTTOM_GAP_PX for a turn taller than the viewport', () => {
    expect(roomUnderNewestTurn(800, 2000)).toBe(BOTTOM_GAP_PX);
    expect(roomUnderNewestTurn(800, 800 - TURN_TOP_OFFSET)).toBe(BOTTOM_GAP_PX);
  });
  test('a transcript with no turn yet reserves the whole viewport', () => {
    expect(roomUnderNewestTurn(800, null)).toBe(800);
  });
});

describe('isAtEnd — THE RULE resumes only at the end', () => {
  test('within AT_END_PX counts as at the end (drags rarely land on the pixel)', () => {
    expect(isAtEnd(0)).toBe(true);
    expect(isAtEnd(AT_END_PX)).toBe(true);
    expect(isAtEnd(-3)).toBe(true);
  });
  test('anything further is away — a jittery wheel tick never re-arms follow', () => {
    expect(isAtEnd(AT_END_PX + 1)).toBe(false);
    expect(isAtEnd(80)).toBe(false);
  });
});

describe('chevronVisible — measured in CONTENT, the room excluded', () => {
  test('hidden while the reader is only a little way up', () => {
    expect(chevronVisible(CHEVRON_PX)).toBe(false);
    expect(chevronVisible(0)).toBe(false);
  });
  test('shown once meaningfully away from the end of the content', () => {
    expect(chevronVisible(CHEVRON_PX + 1)).toBe(true);
  });
});

// ── Keyboard intent ──────────────────────────────────────────────────
// The bug these cover: at the end, Cmd+↑ scrolled up for an instant and the
// next settle() put it straight back, because the keydown listener was bound
// to the transcript element. The element has no tabindex, so the browser
// delivers the key to <body> and that listener never fired. Follow was never
// told the reader had taken over. The listener now sits on `document`, which
// makes "is this key for the transcript?" the whole question below.

/** Minimal EventTarget stand-in: the guards read only tagName /
 *  isContentEditable / closest, so no DOM is needed for the full matrix. */
function target(
  tagName: string,
  opts: { isContentEditable?: boolean; matches?: string[] } = {},
): EventTarget {
  const matches = opts.matches ?? [];
  return {
    tagName,
    isContentEditable: opts.isContentEditable ?? false,
    closest: (selector: string) =>
      matches.some((m) => selector.includes(m)) ? ({} as unknown) : null,
  } as unknown as EventTarget;
}

const BODY = target('BODY');

describe('classifyScrollKey', () => {
  test('every upward key is one intent, modifiers included', () => {
    expect(classifyScrollKey({ key: 'ArrowUp' })).toBe('up');
    // macOS "scroll to top" — the exact key in the report.
    expect(classifyScrollKey({ key: 'ArrowUp', metaKey: true })).toBe('up');
    expect(classifyScrollKey({ key: 'PageUp' })).toBe('up');
    expect(classifyScrollKey({ key: 'Home' })).toBe('up');
    expect(classifyScrollKey({ key: 'Home', ctrlKey: true } as never)).toBe('up');
    expect(classifyScrollKey({ key: ' ', shiftKey: true })).toBe('up');
  });

  test('incremental downward keys are ordinary movement', () => {
    expect(classifyScrollKey({ key: 'ArrowDown' })).toBe('down');
    expect(classifyScrollKey({ key: 'PageDown' })).toBe('down');
    expect(classifyScrollKey({ key: ' ' })).toBe('down');
    expect(classifyScrollKey({ key: 'Spacebar' })).toBe('down');
  });

  test('"go to the end" keys are their own intent', () => {
    expect(classifyScrollKey({ key: 'End' })).toBe('end');
    expect(classifyScrollKey({ key: 'End', ctrlKey: true } as never)).toBe('end');
    expect(classifyScrollKey({ key: 'ArrowDown', metaKey: true })).toBe('end');
  });

  test('non-scrolling keys and Alt/Option chords are ignored', () => {
    expect(classifyScrollKey({ key: 'a' })).toBe(null);
    expect(classifyScrollKey({ key: 'Enter' })).toBe(null);
    expect(classifyScrollKey({ key: 'ArrowLeft' })).toBe(null);
    expect(classifyScrollKey({ key: 'ArrowRight' })).toBe(null);
    expect(classifyScrollKey({ key: 'Tab' })).toBe(null);
    // Option+Arrow is a caret move on macOS, never a scroll.
    expect(classifyScrollKey({ key: 'ArrowUp', altKey: true })).toBe(null);
    expect(classifyScrollKey({ key: 'ArrowDown', altKey: true })).toBe(null);
  });
});

describe('isEditableTarget', () => {
  test('form fields and contenteditable own their own caret', () => {
    expect(isEditableTarget(target('TEXTAREA'))).toBe(true);
    expect(isEditableTarget(target('INPUT'))).toBe(true);
    expect(isEditableTarget(target('SELECT'))).toBe(true);
    expect(isEditableTarget(target('DIV', { isContentEditable: true }))).toBe(true);
    expect(isEditableTarget(target('SPAN', { matches: ['role="textbox"'] }))).toBe(true);
  });

  test('plain content and a missing target are not editable', () => {
    expect(isEditableTarget(BODY)).toBe(false);
    expect(isEditableTarget(target('DIV'))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});

describe('keyScrollIntentFor', () => {
  test('Cmd+ArrowUp on the transcript leaves the end — the reported bug', () => {
    expect(keyScrollIntentFor({ key: 'ArrowUp', metaKey: true, target: BODY })).toBe('up');
    expect(keyScrollIntentFor({ key: 'ArrowUp', target: BODY })).toBe('up');
    expect(keyScrollIntentFor({ key: 'PageUp', target: BODY })).toBe('up');
    expect(keyScrollIntentFor({ key: 'Home', target: BODY })).toBe('up');
  });

  test('End / Cmd+ArrowDown go to the end; PageDown only resumes if it lands there', () => {
    expect(keyScrollIntentFor({ key: 'End', target: BODY })).toBe('end');
    expect(keyScrollIntentFor({ key: 'ArrowDown', metaKey: true, target: BODY })).toBe('end');
    expect(keyScrollIntentFor({ key: 'PageDown', target: BODY })).toBe('down');
    expect(keyScrollIntentFor({ key: 'ArrowDown', target: BODY })).toBe('down');
  });

  test('a keypress inside the composer is never transcript intent', () => {
    const composer = target('TEXTAREA');
    expect(keyScrollIntentFor({ key: 'ArrowUp', metaKey: true, target: composer })).toBe(null);
    expect(keyScrollIntentFor({ key: 'ArrowUp', target: composer })).toBe(null);
    expect(keyScrollIntentFor({ key: 'PageUp', target: composer })).toBe(null);
    expect(keyScrollIntentFor({ key: 'Home', target: composer })).toBe(null);
    expect(keyScrollIntentFor({ key: 'End', target: composer })).toBe(null);
    expect(keyScrollIntentFor({ key: ' ', target: composer })).toBe(null);
    // Rich-text composers are contenteditable, not <textarea>.
    expect(
      keyScrollIntentFor({ key: 'ArrowUp', target: target('DIV', { isContentEditable: true }) }),
    ).toBe(null);
  });

  test('Space on a focused button activates it instead of scrolling', () => {
    const button = target('BUTTON', { matches: ['button'] });
    expect(keyScrollIntentFor({ key: ' ', target: button })).toBe(null);
    expect(keyScrollIntentFor({ key: ' ', shiftKey: true, target: button })).toBe(null);
    // Arrows still scroll while a button holds focus — Chrome does not eat them.
    expect(keyScrollIntentFor({ key: 'ArrowUp', target: button })).toBe('up');
    expect(keyScrollIntentFor({ key: 'End', target: button })).toBe('end');
  });

  test('non-scroll keys stay null wherever focus is', () => {
    expect(keyScrollIntentFor({ key: 'k', metaKey: true, target: BODY })).toBe(null);
    expect(keyScrollIntentFor({ key: 'Escape', target: BODY })).toBe(null);
  });
});

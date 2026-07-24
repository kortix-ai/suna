import { afterAll, describe, expect, it } from 'bun:test';
import type { ToolPart } from '@/ui';
import {
  actionTimeLabel,
  clampIndex,
  isEditableTarget,
  nextIndex,
  prevIndex,
} from './action-navigator-logic';

// ─── Minimal DOM stub ───────────────────────────────────────────────────────
// This package has no jsdom/happy-dom dependency (bun test's runtime has no
// DOM at all — see shader-safe.test.ts for the same constraint handled the
// same way: a hand-rolled stub, installed for this file only). isEditableTarget
// is a predicate over DOM shape (tagName, class, closest()), so the stub only
// needs to be truthful about that shape, not a full DOM implementation.
class FakeElement {
  readonly tagName: string;
  isContentEditable = false;
  parentElement: FakeElement | null = null;
  private readonly attrs = new Map<string, string>();

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  get className(): string {
    return this.attrs.get('class') ?? '';
  }
  set className(value: string) {
    this.attrs.set('class', value);
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  appendChild<T extends FakeElement>(child: T): T {
    child.parentElement = this;
    return child;
  }

  private matches(selector: string): boolean {
    if (selector.startsWith('.')) {
      return this.className.split(/\s+/).includes(selector.slice(1));
    }
    const attr = /^\[([\w-]+)="([^"]*)"\]$/.exec(selector);
    return attr != null && this.attrs.get(attr[1]) === attr[2];
  }

  // Recursive rather than a walk loop: seeding a local with `this` trips
  // @typescript-eslint/no-this-alias, which is an error in the Next build lint
  // even though it passes a bare `eslint <file>` run.
  closest(selector: string): FakeElement | null {
    if (this.matches(selector)) return this;
    return this.parentElement?.closest(selector) ?? null;
  }
}

const realDocument = (globalThis as { document?: unknown }).document;
(globalThis as { document?: unknown }).document = {
  createElement: (tag: string) => new FakeElement(tag),
};
afterAll(() => {
  (globalThis as { document?: unknown }).document = realDocument;
});

function partAt(ms: number | undefined, key: 'start' | 'end' = 'end'): ToolPart {
  return { state: { time: ms === undefined ? {} : { [key]: ms } } } as unknown as ToolPart;
}

describe('clampIndex', () => {
  it('pins an over-long index to the last action when the list shrinks', () => {
    expect(clampIndex(9, 3)).toBe(2);
  });

  it('never returns a negative index for an empty list', () => {
    expect(clampIndex(4, 0)).toBe(0);
  });
});

describe('nextIndex', () => {
  it('re-arms live-follow on reaching the last action', () => {
    expect(nextIndex(1, 3)).toEqual({ index: 2, mode: 'live' });
  });

  it('stays manual while short of the end', () => {
    expect(nextIndex(0, 5)).toEqual({ index: 1, mode: 'manual' });
  });

  it('does not step past the last action', () => {
    expect(nextIndex(4, 5)).toEqual({ index: 4, mode: 'live' });
  });
});

describe('prevIndex', () => {
  it('pins manual mode so live-follow does not snap the user forward', () => {
    expect(prevIndex(3)).toEqual({ index: 2, mode: 'manual' });
  });

  it('does not step below the first action', () => {
    expect(prevIndex(0)).toEqual({ index: 0, mode: 'manual' });
  });
});

describe('actionTimeLabel', () => {
  const now = new Date('2026-07-23T15:00:00');

  it('shows time only for an action from today', () => {
    const label = actionTimeLabel(partAt(new Date('2026-07-23T14:12:30').getTime()), now);
    expect(label).not.toContain('Jul');
    expect(label.length).toBeGreaterThan(0);
  });

  it('adds the date for an action from another day', () => {
    const label = actionTimeLabel(partAt(new Date('2026-07-21T14:12:30').getTime()), now);
    expect(label).toContain('Jul');
  });

  it('falls back to the start time while an action is still running', () => {
    expect(actionTimeLabel(partAt(new Date('2026-07-23T14:12:30').getTime(), 'start'), now))
      .not.toBe('');
  });

  it('is empty when the action carries no time at all', () => {
    expect(actionTimeLabel(partAt(undefined), now)).toBe('');
    expect(actionTimeLabel(undefined, now)).toBe('');
  });
});

// ─── ←/→ must never steal the caret. Every one of these contexts regressed at
// least once in the original panel, which is why each is pinned separately
// rather than as a single "is it editable" case. ──────────────────────────────

describe('isEditableTarget', () => {
  it('is false for a plain element', () => {
    expect(isEditableTarget(document.createElement('div'))).toBe(false);
  });

  it('is false for no element at all', () => {
    expect(isEditableTarget(null)).toBe(false);
  });

  it('is true for an input', () => {
    expect(isEditableTarget(document.createElement('input'))).toBe(true);
  });

  it('is true for a textarea', () => {
    expect(isEditableTarget(document.createElement('textarea'))).toBe(true);
  });

  it('is true inside a CodeMirror editor', () => {
    const editor = document.createElement('div');
    editor.className = 'cm-editor';
    const inner = document.createElement('span');
    editor.appendChild(inner);
    expect(isEditableTarget(inner)).toBe(true);
  });

  it('is true inside a ProseMirror editor', () => {
    const editor = document.createElement('div');
    editor.className = 'ProseMirror';
    const inner = document.createElement('span');
    editor.appendChild(inner);
    expect(isEditableTarget(inner)).toBe(true);
  });

  it('is true on the scrubber, which handles arrow keys itself', () => {
    const slider = document.createElement('div');
    slider.setAttribute('data-slot', 'slider');
    expect(isEditableTarget(slider)).toBe(true);
  });

  it('is true for a contenteditable element', () => {
    // isContentEditable is readonly in lib.dom's HTMLElement — the stub carries
    // it as a plain writable field, same as tagName/className above.
    const editable = document.createElement('div') as HTMLElement & { isContentEditable: boolean };
    editable.isContentEditable = true;
    expect(isEditableTarget(editable)).toBe(true);
  });
});

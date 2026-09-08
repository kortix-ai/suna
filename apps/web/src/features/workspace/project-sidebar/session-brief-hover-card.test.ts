import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const briefSource = readFileSync(join(import.meta.dir, 'session-brief-hover-card.tsx'), 'utf8');
const hoverCardSource = readFileSync(
  join(import.meta.dir, '../../../components/ui/hover-card.tsx'),
  'utf8',
);
const scrollAreaSource = readFileSync(
  join(import.meta.dir, '../../../components/ui/faded-scroll-area.tsx'),
  'utf8',
);

/**
 * `indexOf` returns -1 for a missing anchor, and `slice(-1, n)` yields ''. A
 * `not.toContain` against '' passes, so a rename would silently retire every
 * assertion below instead of failing. Throwing on a missing anchor is what
 * keeps these tests able to fail.
 */
function between(source: string, open: string, close: string): string {
  const start = source.indexOf(open);
  if (start === -1) throw new Error(`anchor not found: ${open}`);
  const end = source.indexOf(close, start + open.length);
  if (end === -1) throw new Error(`anchor not found after ${open}: ${close}`);
  return source.slice(start, end);
}

describe('session brief hover card portal', () => {
  test('escapes the sidebar scroll container', () => {
    // The reason the rule exists: an earlier revision portaled the panel into
    // this container to shorten the tab path, and it clipped the right-side card.
    expect(scrollAreaSource).toContain('overflow-y-auto');

    expect(between(briefSource, '<HoverCardContent', '</HoverCardContent>')).not.toContain(
      'container',
    );
    // The shared primitive is the only portal in the path, so the escape hatch
    // has to be absent there too.
    expect(between(hoverCardSource, 'HoverCardPrimitive.Portal', '/>')).not.toContain('container');
  });
});

describe('session status agreement', () => {
  const listSource = readFileSync(join(import.meta.dir, 'project-session-list.tsx'), 'utf8');

  test('the row dot and the hover card read the same status', () => {
    // `sessionDisplayStatus(session, reviewCount)` defaults reviewCount to 0, so
    // a single-argument call does not mean "unknown" — it asserts "nothing is
    // waiting". That is how the dot went green while the card went grey, on the
    // same row, with the change requests responsible listed inside the card.
    const calls = listSource.match(/sessionDisplayStatus\([^)]*\)/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call).toContain('reviewCount');
    }
  });

  test('both surfaces are handed one status value, not two computations', () => {
    // Agreement by construction: the card and the screen-reader description read
    // the same binding the row was built from.
    expect(listSource).toContain(
      'const displayStatus = sessionDisplayStatus(session, reviewCount)',
    );
    expect(listSource).not.toContain('lifecycleStatus');
  });
});

describe('session brief hover card surface', () => {
  test('wears the shared floating-panel recipe rather than its own', () => {
    expect(hoverCardSource).toContain('FLOATING_PANEL');
    // Hand-written surface values are what drifted this panel a shadow step and
    // 2px of radius away from every other floating panel.
    const content = between(hoverCardSource, 'function HoverCardContent', 'export {');
    expect(content).not.toContain('shadow-sm');
    expect(content).not.toContain('rounded-md');
    // The one accessibility guard no other panel ships must survive the move.
    expect(content).toContain('motion-reduce:animate-none');
  });

  test('reuses the app-wide floating-list row for change requests', () => {
    expect(briefSource).toContain("menuRow('sm', 'default'");
    // A local row recipe is how this list stops lining up with the footer's
    // change chooser and every menu in the product.
    expect(briefSource).not.toContain('CHANGE_REQUEST_ACTION_CLASS');
  });
});

describe('session source icons', () => {
  const listSource = readFileSync(join(import.meta.dir, 'project-session-list.tsx'), 'utf8');
  const mapSource = readFileSync(join(import.meta.dir, 'session-source-icons.ts'), 'utf8');

  test('the row and the card read one map, not a copy each', () => {
    // Two maps that happen to agree is not the same as one map. The row and its
    // own hover card describe the same session, so two glyphs for it would leave
    // a reader no way to tell which was true.
    for (const consumer of [listSource, briefSource]) {
      expect(consumer).toContain('SOURCE_ICONS');
      expect(consumer).not.toContain('const SOURCE_ICONS');
    }
  });

  test('email and schedule use the local marks, not Phosphor', () => {
    // Scoped to the map body: the doc comment above it names the old icons on
    // purpose, and a whole-file match would read that prose as code.
    const map = between(mapSource, 'export const SOURCE_ICONS', '};');
    expect(map).toContain('email: Email');
    expect(map).toContain('schedule: Schedule');
    expect(map).not.toContain('EnvelopeIcon');
    expect(map).not.toContain('CalendarDotsIcon');
  });

  test('chat is excluded by type, not by a blank glyph', () => {
    // `chat` is the fallback every session lands in when nothing claims it. It
    // renders no icon at all, and the Exclude makes adding one a type error.
    expect(mapSource).toContain("Exclude<SessionSourceKind, 'chat'>");
  });
});

describe('change request rows', () => {
  test('every state wears one glyph, and only the colour varies', () => {
    // Three shapes in a list that holds one kind of thing read as three kinds of
    // thing. The row says "change request" by being in this list; the colour is
    // the only thing that should differ between the states.
    expect(briefSource).not.toContain('CHANGE_REQUEST_STATUS_ICON');
    expect(briefSource).not.toContain('CheckCircleIcon');
    expect(briefSource).not.toContain('XCircleIcon');
    expect(briefSource).toContain(
      '<GitDiffIcon className={CHANGE_REQUEST_STATUS_CLASS[changeRequest.status]}',
    );
  });

  test('open reads blue, merged green, closed red', () => {
    const map = between(briefSource, 'CHANGE_REQUEST_STATUS_CLASS: Record', '};');
    expect(map).toContain("open: 'text-kortix-blue'");
    expect(map).toContain("merged: 'text-kortix-green'");
    expect(map).toContain("closed: 'text-kortix-red'");
    // A closed change is a decision, not an absence — it must not fade out.
    expect(map).not.toContain('text-muted-foreground');
  });
});

describe('session brief hover card timing', () => {
  test('opens with no enter animation', () => {
    // The card opens to the right, into the path the pointer is already taking,
    // so an enter animation is time spent moving content away from the hand.
    expect(between(briefSource, '<HoverCardContent', '</HoverCardContent>')).toContain(
      'animated={false}',
    );
  });

  test('hands timing and exclusivity to the shared group store', () => {
    // Both are properties of the LIST, not of one card: only one may be open,
    // and the second row the pointer visits must not pay the delay again.
    expect(briefSource).toContain('useSessionHoverStore');
    expect(briefSource).not.toContain('setTimeout');

    // Radix's per-instance delays must stay out of the way, or they would
    // re-introduce the close-then-reopen gap the store exists to remove.
    const root = between(briefSource, '<HoverCard ', '<HoverCardTrigger');
    expect(root).toContain('openDelay={0}');
    expect(root).toContain('closeDelay={0}');
    // With closeDelay={0}, a wired onOpenChange would report a close the instant
    // the pointer left the row, cancelling the travel-into-the-card window.
    expect(root).not.toContain('onOpenChange');
  });

  test('stays dismissable from the keyboard', () => {
    // WCAG 1.4.13. Radix's own dismissal runs through `setOpen`, which is inert
    // while the store owns `open`, so this must reach the store directly.
    expect(between(briefSource, '<HoverCardContent', '</HoverCardContent>')).toContain(
      'onEscapeKeyDown={dismiss}',
    );
  });
});

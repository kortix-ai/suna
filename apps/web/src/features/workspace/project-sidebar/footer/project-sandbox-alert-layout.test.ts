/**
 * The sandbox alert answers to the panel it sits in, and it speaks to a person.
 *
 * Two defects are pinned here.
 *
 * **It measured the window.** `sidebar-width.ts` clamps the sidebar between
 * 208px and 416px and the window does not move while it is dragged, so a
 * `sm:`/`md:` step would be wrong at both ends. The failure meta was also one
 * flex line holding a `whitespace-nowrap` Badge and a `shrink-0` timestamp —
 * ~240px of content, none of it allowed to give, in a ~176px box at the floor.
 *
 * **It printed the build's error at the reader.** `failure.error` went into a
 * scrolling `<pre>`, which on a real failure is an absolute path from the build
 * machine, wrapped over four lines and cut mid-word. It was the largest object
 * on the card and nobody reading a sidebar can act on it.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SIDEBAR_MAX_WIDTH_PX, SIDEBAR_MIN_WIDTH_PX } from '@/components/ui/sidebar-width';

const source = readFileSync(join(import.meta.dir, 'project-sandbox-alert.tsx'), 'utf8');
const code = source.replace(/^[ \t]*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const primitive = readFileSync(join(import.meta.dir, 'sidebar-alert.tsx'), 'utf8');

/** Sidebar gutter (px-2) + alert body gutter (px-2) = 32px of chrome. */
const cardWidth = (sidebarWidth: number) => sidebarWidth - 32;

describe('the card speaks to a person, not to a build log', () => {
  test('the raw error never reaches the card', () => {
    // It lives in Details, beside the whole log, instead of a 70px window onto
    // the middle of it. Mintlify, Buffer and Family all make this same split.
    expect(code).not.toContain('failure.error}');
    expect(code).not.toContain('<pre');
  });

  test('every failure category has a sentence a non-engineer can act on', () => {
    // A category with no entry would render the fallback, not a blank line.
    const labels = code.slice(code.indexOf('const CATEGORY_LABEL'));
    const causes = code.slice(code.indexOf('const CATEGORY_CAUSE:'));
    for (const key of ['quota', 'dockerfile', 'git', 'tunnel', 'provider', 'timeout', 'runtime', 'unknown']) {
      expect(labels).toContain(`${key}:`);
      expect(causes.slice(0, causes.indexOf('};'))).toContain(`${key}:`);
    }
    expect(code).toContain('?? CATEGORY_CAUSE_FALLBACK');
  });

  test('the cause copy carries no paths, no identifiers, no jargon', () => {
    const causes = code.slice(
      code.indexOf('const CATEGORY_CAUSE:'),
      code.indexOf('const CATEGORY_CAUSE_FALLBACK'),
    );
    for (const jargon of ['/Users', 'artifact missing', 'KORTIX_', 'stderr', 'exit code', 'null']) {
      expect(causes).not.toContain(jargon);
    }
  });
});

describe('the sandbox alert measures its panel, not the window', () => {
  test('the card declares a container for its own steps to read', () => {
    expect(code).toContain('@container/alert');
  });

  test('no step is a viewport breakpoint', () => {
    for (const viewportOnly of ['sm:', 'md:', 'lg:', 'xl:', '2xl:']) {
      expect(code).not.toContain(` ${viewportOnly}`);
    }
  });

  test('every responsive step names the container it belongs to', () => {
    // A `@2xs:` variant with no matching container name resolves against the
    // nearest ANY container, which is not necessarily this card.
    const steps = code.match(/@[\w]+\/[\w]+:/g) ?? [];
    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) {
      expect(step.split('/')[1]).toBe('alert:');
    }
  });

  test('the default sidebar width gets STACKED actions', () => {
    // `@2xs` is 18rem/288px. A 256px sidebar is a 224px card, well below it —
    // two half-width buttons there would each ellipsize to nothing.
    expect(cardWidth(256)).toBeLessThan(288);
    expect(cardWidth(SIDEBAR_MIN_WIDTH_PX)).toBeLessThan(288);
    expect(code).toContain('flex flex-col gap-1.5 @2xs/alert:flex-row');
  });

  test('a widened sidebar earns side-by-side actions', () => {
    expect(cardWidth(320)).toBeGreaterThanOrEqual(288);
    expect(cardWidth(SIDEBAR_MAX_WIDTH_PX)).toBeGreaterThanOrEqual(288);
  });

  test('the failure meta wraps rather than truncates', () => {
    // Dropping the Badge took ~140px of `whitespace-nowrap` chrome out of this
    // line, so it needs no breakpoint at all. It is a `<p>`, so a long category
    // wraps — this is the sentence naming what broke and half of it is not
    // useful.
    expect(code).toContain('<p className="text-xs leading-5">');
    expect(code).not.toContain('<Badge');
    expect(code).not.toContain('CATEGORY_DOT');
  });
});

describe('one left edge, two seams, one focal control', () => {
  test('every text line starts at the same x', () => {
    // The old card had four left edges: the message at 8px, a tone dot at 8px,
    // its label at 20px, and the error block's own text at 16px. The dot and
    // the error block are both gone, so 8px is the only one left.
    expect(code).not.toContain('size-1.5 shrink-0 rounded-full');
    expect(primitive).toContain("cn('px-2 py-2.5', className)");
    expect(primitive).toContain('border-t p-2');
  });

  test('the body no longer hugs the top edge of the card', () => {
    // This body renders ABOVE its trigger, so it owns the card's top edge, and
    // `pt-0.5` put 2px of air over the first line against 8px at the sides.
    expect(primitive).not.toContain('px-2 pt-0.5 pb-3');
  });

  test('the trigger closes the card when the disclosure is open', () => {
    // Open, the trigger is the card's bottom band and the tray's buttons ran
    // straight into it. Closed, there is nothing above it to separate from.
    expect(primitive).toContain("open && 'border-border/60 rounded-t-none border-t'");
  });

  test('the card has ONE focal control', () => {
    // Every button was `variant="outline"` when no agent fix was available, so
    // the reader's one action looked exactly like the navigation beside it.
    expect(code).toContain(
      "retryVariant: canFixWithAgent ? ('outline' as const) : ('default' as const)",
    );
    expect(code).toContain('variant={recovery.retryVariant}');
  });

  test('the committing actions give press feedback', () => {
    // 0.96 is the floor this product uses; below 0.95 reads as exaggerated.
    expect(code).toContain("const ACTION_BUTTON = 'w-full active:scale-[0.96]';");
    expect(code).not.toContain('transition-all');
  });

  test('the card carries no inner fill of its own', () => {
    // It had four stacked in ~180px: the card tint, the badge tint, the error
    // fill and the button. Only the card tint and the button remain.
    expect(code).not.toContain('bg-muted');
    expect(code).not.toContain('mask-image');
  });
});

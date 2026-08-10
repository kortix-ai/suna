import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const STEP_DIR = resolve(import.meta.dir);

/**
 * A region the pointer can scroll but the keyboard cannot reach is a WCAG 2.1.1
 * failure — axe reports it as `scrollable-region-focusable` at `serious`, and
 * the landing-page audit in tests/accessibility/landing.a11y.spec.ts treats
 * serious violations as blocking.
 *
 * The step panels render fixed snippets with no interactive child, so nothing
 * inside them can take focus on the container's behalf. Each scrollable `<pre>`
 * therefore has to carry the tab stop itself.
 *
 * This reads source rather than rendering because axe only flags the panel that
 * actually overflows at the audited viewport — the browser audit cannot see a
 * sibling that happens to fit, and that sibling is exactly what regresses at the
 * next breakpoint.
 */
function stepSources(): { file: string; source: string }[] {
  return readdirSync(STEP_DIR)
    .filter((file) => file.endsWith('.tsx'))
    .map((file) => ({ file, source: readFileSync(resolve(STEP_DIR, file), 'utf8') }));
}

/** Each `<pre …>` open tag, attributes included, comments already stripped. */
function preOpenTags(source: string): string[] {
  const withoutComments = source.replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
  return [...withoutComments.matchAll(/<pre\b[^>]*>/g)].map((match) => match[0]);
}

describe('how-it-works step panels', () => {
  test('the step folder still has panels to check', () => {
    const tags = stepSources().flatMap(({ source }) => preOpenTags(source));
    expect(tags.length).toBeGreaterThan(0);
  });

  test('every scrollable <pre> is keyboard focusable', () => {
    const offenders = stepSources().flatMap(({ file, source }) =>
      preOpenTags(source)
        .filter((tag) => tag.includes('overflow-x-auto'))
        .filter((tag) => !/tabIndex=\{0\}/.test(tag))
        .map((tag) => `${file}: ${tag}`),
    );

    expect(offenders).toEqual([]);
  });
});

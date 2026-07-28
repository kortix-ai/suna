import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every variant must handle every activity item type.
 *
 * This guards a real bug that shipped and was caught in review: Variant B's
 * `switch` handled only text/group/tool/deliverable, so `reasoning` and
 * `passthrough` fell through to `default: return null` — silently deleting the
 * todo checklist, question prompts and sub-agent cards from the transcript.
 * Nothing was collapsed or one-click-away; they were never emitted to the DOM.
 *
 * Folding machinery is the whole point of this work. Dropping content the
 * reader has to see never was — and the two failure modes look identical in a
 * diff, which is exactly why this needs a test.
 *
 * This is a SOURCE-level check rather than a render assertion because the web
 * app has no DOM test harness (`bun test` here runs pure logic only). A
 * rendering test would be strictly better; if a harness is ever added, replace
 * this with one that mounts each variant over `demo-transcript.ts` and asserts
 * the todo/question/reasoning content is present.
 */

const ITEM_TYPES = ['reasoning', 'text', 'group', 'tool', 'deliverable', 'passthrough'] as const;

/**
 * Variants that consume `buildActivityItems` directly and therefore own a
 * switch over its output.
 *
 * Excluded, deliberately:
 *   - `variant-adaptive`  — delegates wholesale to Grouped/Narrative, owns no switch.
 *   - `variant-current`   — the "Today" reproduction; it walks raw parts on
 *                           purpose, because reproducing today's behaviour is
 *                           its entire job.
 */
const VARIANTS = ['variant-grouped', 'variant-activity-card', 'variant-narrative'];

function sourceOf(name: string): string {
  return readFileSync(join(import.meta.dir, `${name}.tsx`), 'utf8');
}

describe('activity item coverage', () => {
  for (const variant of VARIANTS) {
    describe(variant, () => {
      const source = sourceOf(variant);

      for (const type of ITEM_TYPES) {
        test(`handles the "${type}" item`, () => {
          // Either an explicit `case '<type>':`, or the item type named in a
          // filter/predicate — Narrative partitions the list instead of
          // switching over it, which is an equally complete treatment.
          const handled =
            source.includes(`case '${type}'`) || source.includes(`item.type === '${type}'`);
          expect(handled).toBe(true);
        });
      }
    });
  }

  test('the checked list matches the model’s actual item union', () => {
    // If someone adds a seventh item type to `ActivityItem`, this fails and
    // forces them to decide what every variant does with it, rather than
    // letting three switches silently drop it.
    const model = readFileSync(join(import.meta.dir, '..', 'activity-model.ts'), 'utf8');
    const union = model.slice(
      model.indexOf('export type ActivityItem'),
      model.indexOf('export interface BuildActivityOptions'),
    );
    const declared = [...union.matchAll(/type:\s*'([a-z]+)'/g)].map((m) => m[1]);
    expect([...new Set(declared)].sort()).toEqual([...ITEM_TYPES].sort());
  });
});

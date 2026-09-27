import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const css = readFileSync(fileURLToPath(new URL('../../app/globals.css', import.meta.url)), 'utf8');

/** Every innermost `selector { declarations }` pair, comments removed. */
function rules(source: string): Array<{ selector: string; body: string }> {
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selector: match[1].trim(),
    body: match[2],
  }));
}

/**
 * `UnifiedMarkdown` marks a message that is still streaming with the
 * `streaming-active` class and `data-streaming="true"`. Neither may change how
 * the message lays out.
 *
 * A rule here once set `display: inline` on every `p`, `li`, and `div` that was
 * a last child anywhere inside a streaming message. It matched far more than
 * prose: the setup-link card's root and its action slot are `div:last-child`,
 * so the card rendered as a split inline box — an empty rounded sliver above
 * the content, the icon centred in its own row, and a second sliver below —
 * until the turn ended. It also dropped the bullet from the last list item,
 * and it had already been patched twice with `:not()` exclusions, for tables
 * and for KaTeX. Nothing rendered after the markdown needed the last block to
 * be inline.
 *
 * The rule is the contract: a streaming message and the same message settled
 * produce the same boxes, so the transcript does not reflow when a turn ends.
 */
describe('streaming markdown layout', () => {
  test('no rule changes display while a message streams', () => {
    const offenders = rules(css).filter(
      ({ selector, body }) =>
        /streaming-active|data-streaming/.test(selector) && /(^|[;\s])display\s*:/.test(body),
    );

    expect(offenders.map(({ selector }) => selector)).toEqual([]);
  });

  test('the parser sees the rules it guards', () => {
    // Without this, a rules() regression that returns nothing would pass the
    // test above vacuously.
    const streaming = rules(css).filter(({ selector }) => selector.includes('streaming-active'));

    expect(streaming.length).toBeGreaterThan(0);
  });
});

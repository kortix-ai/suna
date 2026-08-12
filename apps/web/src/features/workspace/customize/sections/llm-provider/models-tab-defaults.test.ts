import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { wireToModelKey } from '@kortix/sdk/react';

/**
 * The two default SCOPES this tab owns.
 *
 * Both used to be buttons stacked under the session model picker
 * (`features/session/model-selector.tsx`), which could SET a default at three
 * scopes while showing which model held none of them. They moved onto the row
 * they apply to, where each one also badges its current holder. The picker
 * keeps a one-click star for the account default only.
 *
 * `ModelsTab` reads three query hooks and renders inside a modal, so there is
 * no cheap way to mount it here. These pin the two things that actually broke
 * when this moved: the identity comparison that decides which row is badged,
 * and the gate that decides which rows offer the menu at all.
 */

/**
 * Comments stripped first — a `toContain` over a whole file otherwise matches
 * the file's own doc comment rather than its code. Same helper, same reason, as
 * `llm-provider-modal.test.ts`.
 */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const tabSource = code(join(import.meta.dir, 'models-tab.tsx'));

describe('the identity a badged row is decided by', () => {
  /**
   * `models-tab.tsx` asks `defaults.accountDefault?.modelID === wireId`. That
   * only holds because every scope in `useModelDefaults` is built with
   * `wireToModelKey`, which parks the WHOLE wire id in `modelID` under the
   * synthetic `kortix` provider rather than splitting it. If that ever changes
   * to a real split, the comparison silently stops matching and every row
   * quietly loses its badge — no error, no failing render.
   */
  test('wireToModelKey keeps the whole wire id in modelID', () => {
    expect(wireToModelKey('glm-5.2')).toEqual({ providerID: 'kortix', modelID: 'glm-5.2' });
  });

  test('a BYOK provider/model wire id is NOT split across the two fields', () => {
    expect(wireToModelKey('anthropic/claude-opus-4-8')).toEqual({
      providerID: 'kortix',
      modelID: 'anthropic/claude-opus-4-8',
    });
  });

  test('the round trip a row comparison depends on holds for both id shapes', () => {
    for (const wire of ['glm-5.2', 'anthropic/claude-opus-4-8', 'us.anthropic.claude-opus-4-8']) {
      expect(wireToModelKey(wire).modelID).toBe(wire);
    }
  });
});

describe('ModelsTab offers both default scopes', () => {
  test('the account default is settable from this tab', () => {
    // The half that was missing: the project default already lived here, the
    // account default only existed under the session picker.
    expect(tabSource).toContain('defaults.setAccountDefault(');
  });

  test('the project default is still settable from this tab', () => {
    expect(tabSource).toContain('defaults.setProjectDefault(');
  });

  test('each scope badges the model that currently holds it', () => {
    // The full `<Tag>` element, NOT the bare words: the scope phrases also
    // appear in the menu items' own labels, so a substring check on a phrase
    // passes with the badge deleted — it cannot fail, which makes it worse
    // than no test. Verified by deleting the tag and watching the loose
    // version stay green.
    //
    // `your default` was `my default`. Both tags are read on someone else's
    // row as often as your own, and "my" in a badge is ambiguous about whose
    // "my" it is; the menu item that SETS it still says "my", because there
    // the reader is the actor.
    expect(tabSource).toContain('<Tag>project default</Tag>');
    expect(tabSource).toContain('<Tag>your default</Tag>');
  });

  /**
   * The wire id's only remaining home. It used to print under every model
   * name — `anthropic/claude-sonnet-4-5` on 34 rows, meaningless to most
   * readers and needed only by the few about to paste one into a config. If
   * this item goes, the id becomes unreachable from the UI entirely, and the
   * row would look no different.
   */
  test('the wire id is off the row and inside the menu', () => {
    expect(tabSource).toContain('Copy model ID');
    expect(tabSource).toContain('clipboard?.writeText(wireId)');
    // Not rendered on the row any more. The id used to sit in a `<code>` with
    // a copy button beside it; both are gone, so asserting on those two is
    // asserting on the thing that was actually deleted. (A looser check like
    // `not.toContain('{wireId}')` cannot fail — `key={wireId}` keeps it true
    // forever.)
    expect(tabSource).not.toContain('<ModelIdCopyButton');
    expect(tabSource).not.toContain('<code');
  });

  /**
   * `modelPlainSummary` is the row's ONLY subtitle. The raw catalog figures it
   * replaced must not creep back onto the row beside it.
   */
  test('the row shows no raw catalog figures', () => {
    expect(tabSource).toContain('modelPlainSummary({');
    expect(tabSource).not.toContain('per 1M');
    expect(tabSource).not.toContain('formatPricePerMillion');
    expect(tabSource).not.toContain('formatTokenCount');
    expect(tabSource).not.toContain('<ModelCapabilityIcons');
  });

  test('the menu is gated on the model being offered, not on it lacking a scope', () => {
    // The old gate was `!isProjectDefault && enabled`, which hid the control on
    // exactly the row you would reach for to ALSO make it your own default.
    // A model the project does not offer still gets no menu — the server
    // refuses to default to it.
    expect(tabSource).not.toContain('!isProjectDefault && enabled');
    expect(tabSource).toContain('{enabled && (');
  });
});

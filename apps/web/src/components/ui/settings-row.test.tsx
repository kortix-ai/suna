/**
 * `SettingsRow` alignment — a regression test for a bug this component shipped
 * with on its first commit.
 *
 * The row is built on `Field orientation="horizontal"`, whose variant carries
 * `has-[>[data-slot=field-content]]:items-start`. `SettingsRow` ALWAYS renders
 * a `FieldContent`, so that rule always matches — and at specificity (0,2,0) it
 * beats a plain `items-center` (0,1,0). The description-less branch was
 * therefore dead: every control top-aligned against a single-line label. The
 * fix is the important flag, and this test is what stops it being "tidied" away
 * by someone who reasonably assumes `!` is noise.
 *
 * Asserted on the class attribute rather than on computed layout because
 * apps/web has no DOM testing library — no jsdom, no happy-dom — so there is no
 * layout to compute. That is a real limit: this proves the class is emitted,
 * not that the pixels line up.
 */

import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { SettingsRow, SettingsRowGroup } from './settings-row';

/**
 * The class attribute, with HTML entities decoded.
 *
 * `renderToStaticMarkup` escapes `>` inside attribute values, so Tailwind's
 * child/`has-` selectors arrive as `has-[&gt;[data-slot=field-content]]:…`.
 * Asserting against the raw markup silently never matches — the first version
 * of this file did exactly that and reported a failure that was in the test,
 * not the component.
 */
function classOf(markup: string): string {
  const raw = markup.match(/class="([^"]*)"/)?.[1] ?? '';
  return raw.replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&');
}

describe('SettingsRow alignment', () => {
  test('a row with no description centres its control, beating Field’s has-[] rule', () => {
    const html = renderToStaticMarkup(<SettingsRow label="Full name">control</SettingsRow>);
    // The important flag is the whole point — a plain `items-center` loses to
    // the variant's `has-[>[data-slot=field-content]]:items-start`.
    expect(classOf(html)).toContain('!items-center');
    expect(classOf(html)).not.toMatch(/(^|\s)items-start(\s|$)/);
  });

  test('a row with a description top-aligns its control', () => {
    const html = renderToStaticMarkup(
      <SettingsRow label="Username" description="One word, like a nickname.">
        control
      </SettingsRow>,
    );
    expect(classOf(html)).toContain('items-start');
    expect(classOf(html)).not.toContain('!items-center');
  });

  test('the rule it has to beat is still present in Field — if this fails, re-check the fix', () => {
    // Pins the reason the important flag exists. If Field ever drops the
    // `has-[]` rule, `!items-center` becomes unnecessary and this test says so
    // out loud rather than leaving a mystery `!` behind.
    const html = renderToStaticMarkup(<SettingsRow label="Full name">control</SettingsRow>);
    expect(classOf(html)).toContain('has-[>[data-slot=field-content]]:items-start');
  });
});

describe('SettingsRowGroup', () => {
  test('rows share one border and are divided, not stacked as separate cards', () => {
    const html = renderToStaticMarkup(
      <SettingsRowGroup>
        <SettingsRow label="One" />
        <SettingsRow label="Two" />
      </SettingsRowGroup>,
    );
    const group = classOf(html);
    expect(group).toContain('divide-y');
    expect(group).toContain('rounded-md');
    expect(group).toContain('border');
    // The rows themselves must not carry their own border — that is the
    // difference between one grouped form and a stack of cards.
    expect(html).not.toContain('border-border rounded-md border px-3 py-2.5');
  });
});

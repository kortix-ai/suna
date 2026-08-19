/**
 * `SettingsRow` alignment — the control is ALWAYS vertically centred.
 *
 * The row is built on `Field orientation="horizontal"`, whose variant carries
 * `has-[>[data-slot=field-content]]:items-start`. `SettingsRow` ALWAYS renders
 * a `FieldContent`, so that rule always matches — and at specificity (0,2,0) it
 * beats a plain `items-center` (0,1,0). The important flag is what wins it, and
 * this file is what stops it being "tidied" away by someone who reasonably
 * assumes `!` is noise.
 *
 * **This used to assert the opposite for described rows** — they top-aligned,
 * on the theory that a control should meet the first line of a two-line label.
 * Jay overrode that on 2026-08-12 ("I want it to be coming always in the
 * centre"), and the reason is visible the moment a group has mixed rows: an
 * `h-8` control sat at a different height in every row depending on whether
 * that row's description happened to wrap, so the right-hand column stopped
 * being a column. Centring is what keeps one scannable right edge.
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

  test('a row WITH a description centres its control too — same as one without', () => {
    const html = renderToStaticMarkup(
      <SettingsRow label="Username" description="One word, like a nickname.">
        control
      </SettingsRow>,
    );
    expect(classOf(html)).toContain('!items-center');
    // No bare `items-start` of our own. `Field`'s `has-[]` rule still mentions
    // the token, which is why this matches on a whitespace-delimited boundary
    // rather than a substring — `toContain('items-start')` would hit
    // `has-[>[data-slot=field-content]]:items-start` and pass no matter what
    // this component emits.
    expect(classOf(html)).not.toMatch(/(^|\s)items-start(\s|$)/);
  });

  test('described and undescribed rows resolve to the SAME alignment', () => {
    // The actual contract, stated once: whatever the alignment is, a
    // description must not change it. Pins the two branches against each other
    // so they cannot drift apart again.
    const bare = classOf(renderToStaticMarkup(<SettingsRow label="One">control</SettingsRow>));
    const described = classOf(
      renderToStaticMarkup(
        <SettingsRow label="One" description="Two.">
          control
        </SettingsRow>,
      ),
    );
    const alignment = (cls: string) => cls.match(/!?items-(center|start)(?=\s|$)/g);
    expect(alignment(described)).toEqual(alignment(bare));
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

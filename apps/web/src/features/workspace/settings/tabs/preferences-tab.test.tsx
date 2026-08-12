import { THEME_OPTIONS } from '@/features/layout/user-menu';
import { WALLPAPERS } from '@/lib/wallpapers';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { PreferencesTabView } from './preferences-tab';

/**
 * Every heading in document order, as `h<level>:<text>`.
 *
 * This used to read `h2` only, from when `SettingsSectionHeader` emitted every
 * heading on this pane at one level. Sections now use
 * `SettingsSubsectionHeader`, which emits `h3` — so an h2-only reader would
 * have seen a single heading and happily agreed with a pane that had lost five
 * of them. Capturing the LEVEL is the point: it pins the hierarchy this pane
 * exists to demonstrate, not just the words.
 */
const headings = (html: string): string[] =>
  [...html.matchAll(/<(h[23])[^>]*>([^<]*)<\/\1>/g)].map((m) => `${m[1]}:${m[2]}`);

const html = () => renderToStaticMarkup(<PreferencesTabView />);

/**
 * The pane title is the only `h2`; every section nests under it as an `h3`.
 * Written out in full rather than counted, because the failure this guards
 * against is a section quietly disappearing — which a count would catch only
 * if someone also remembered to update the number.
 */
const EXPECTED_HEADINGS = [
  'h2:Preferences',
  'h3:Theme',
  'h3:Wallpaper',
  'h3:Sounds',
  'h3:Notifications',
  'h3:Keyboard shortcuts',
  'h3:Language',
];

describe('PreferencesTabView', () => {
  test('appearance leads — Theme is the first SECTION heading, right after the pane heading', () => {
    expect(headings(html())).toEqual(EXPECTED_HEADINGS);
  });

  test('the pane title outranks its sections — one h2, the rest h3', () => {
    const found = headings(html());
    expect(found.filter((h) => h.startsWith('h2:'))).toEqual(['h2:Preferences']);
    expect(found.filter((h) => h.startsWith('h3:'))).toHaveLength(6);
  });

  test('renders every preference section in order', () => {
    expect(headings(html())).toEqual(EXPECTED_HEADINGS);
  });

  test('the pane title outranks its sections — exactly one h2, the rest h3', () => {
    // The hierarchy this pane exists to demonstrate. Asserted on LEVEL, not
    // just text: an h2-only reader agreed happily with a pane that had lost
    // five of its six section headings, because it could only see the one that
    // remained.
    const out = html();
    const h2s = [...out.matchAll(/<h2[^>]*>([^<]*)<\/h2>/g)].map((m) => m[1]);
    const h3s = [...out.matchAll(/<h3[^>]*>([^<]*)<\/h3>/g)].map((m) => m[1]);
    expect(h2s).toEqual(['Preferences']);
    expect(h3s).toEqual([
      'Theme',
      'Wallpaper',
      'Sounds',
      'Notifications',
      'Keyboard shortcuts',
      'Language',
    ]);
  });

  test('offers exactly the themes the user menu offers, in the same order', () => {
    const out = html();
    for (const { label } of THEME_OPTIONS) expect(out).toContain(label);
    const positions = THEME_OPTIONS.map((o) => out.indexOf(o.label));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  test('renders every wallpaper option', () => {
    const out = html();
    for (const wp of WALLPAPERS) expect(out).toContain(wp.name);
  });
});

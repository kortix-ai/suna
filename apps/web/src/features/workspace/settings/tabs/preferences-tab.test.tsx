import { THEME_OPTIONS } from '@/features/layout/user-menu';
import { WALLPAPERS } from '@/lib/wallpapers';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { PreferencesTabView } from './preferences-tab';

/** Section titles in document order, read from the h2s SettingsSectionHeader emits. */
const headings = (html: string): string[] =>
  [...html.matchAll(/<h([23])[^>]*>([^<]*)<\/h\1>/g)].map((m) => m[2]);

const html = () => renderToStaticMarkup(<PreferencesTabView />);

describe('PreferencesTabView', () => {
  test('appearance leads — Theme is the first SECTION heading, right after the pane heading', () => {
    expect(headings(html())).toEqual([
      'Preferences',
      'Theme',
      'Wallpaper',
      'Sounds',
      'Notifications',
      'Keyboard shortcuts',
      'Language',
    ]);
  });

  test('renders every preference section in order', () => {
    expect(headings(html())).toEqual([
      'Preferences',
      'Theme',
      'Wallpaper',
      'Sounds',
      'Notifications',
      'Keyboard shortcuts',
      'Language',
    ]);
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

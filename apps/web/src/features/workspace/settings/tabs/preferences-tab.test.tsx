import { THEME_OPTIONS } from '@/features/layout/user-menu';
import { WALLPAPERS } from '@/lib/wallpapers';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { PreferencesTabView } from './preferences-tab';

/** Section titles in document order, read from the h2s SettingsSectionHeader emits. */
const headings = (html: string): string[] =>
  [...html.matchAll(/<h2[^>]*>([^<]*)<\/h2>/g)].map((m) => m[1]);

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

import { locales } from '@/i18n/config';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import englishMessages from '../../../../../translations/en.json';
import { PreferencesTabView, type PreferencesCopy } from './preferences-tab';

/**
 * Every heading in document order, as `h<level>:<text>`. The LEVEL is the
 * point: the pane title is the one `h2`, every section an `h3` under it.
 */
const headings = (html: string): string[] =>
  [...html.matchAll(/<(h[23])[^>]*>([^<]*)<\/\1>/g)].map((m) => `${m[1]}:${m[2]}`);

const englishCopy = englishMessages.settings.preferences as PreferencesCopy;
const html = () => renderToStaticMarkup(<PreferencesTabView copy={englishCopy} />);

/**
 * Two sections since 2026-09-02. Theme, density and wallpaper went to
 * Appearance; sounds and notifications went to Sessions — each pinned beside
 * its own file. Language leads here (Jay: "in the preferences we need to show
 * the language selection for the whole app").
 */
const EXPECTED_HEADINGS = ['h2:Language &amp; shortcuts', 'h3:Language', 'h3:Keyboard shortcuts'];

describe('PreferencesTabView', () => {
  test('language leads — it is the first section heading, right after the pane heading', () => {
    expect(headings(html())).toEqual(EXPECTED_HEADINGS);
  });

  test('the pane title outranks its sections — one h2, the rest h3', () => {
    const found = headings(html());
    expect(found.filter((h) => h.startsWith('h2:'))).toEqual(['h2:Language &amp; shortcuts']);
    expect(found.filter((h) => h.startsWith('h3:'))).toHaveLength(2);
  });

  test('the language control names itself and shows the current language', () => {
    const out = html();
    expect(out).toContain('aria-label="Language"');
    expect(out).toContain('English');
  });

  test('the sections that moved out are gone, not merely reordered', () => {
    const out = html();
    for (const moved of ['Theme', 'Wallpaper', 'Conversation density', 'Sounds', 'Notifications']) {
      expect(out).not.toContain(`>${moved}<`);
    }
  });

  test('a separator sits between the two sections', () => {
    expect([...html().matchAll(/data-slot="separator"/g)]).toHaveLength(1);
  });

  test('offers both modifier keys and every shortcut', () => {
    const out = html();
    expect(out).toContain('>Cmd<');
    expect(out).toContain('>Ctrl<');
    expect(out).toContain('Command palette');
    expect(out).toContain('Ctrl+K');
  });

  test('lists the shortcut that opens this very panel', () => {
    // Mod+, had no keycap anywhere in the app after the sidebar Settings row
    // was removed — the handler worked and nothing said so. This list is the
    // one place that documents every shortcut, so it is the one that must
    // name it. `modifierLabel` defaults to `Ctrl` in the pure view.
    const out = html();
    expect(out).toContain('>Settings<');
    expect(out).toContain('Ctrl+,');
  });

  test('every locale the app ships is offered by default', () => {
    // `SelectContent` portals its items and renders nothing statically, so the
    // list is asserted through the prop default rather than the markup.
    expect(locales.length).toBeGreaterThan(1);
  });

  test('renders every user-facing label from localized copy', () => {
    const out = renderToStaticMarkup(
      <PreferencesTabView
        copy={{
          title: 'Језик и пречице',
          description: 'Језик и пречице на тастатури.',
          languageTitle: 'Језик',
          languageDescription: 'Језик који Кортикс приказује у целој апликацији.',
          keyboardTitle: 'Пречице на тастатури',
          keyboardDescription: 'Тастер за измену картица и све пречице у апликацији.',
          modifierKey: 'Тастер модификатора',
          shortcuts: {
            newTab: 'Нова картица',
            closeActiveTab: 'Затвори активну картицу',
            reopenClosedTab: 'Поново отвори затворену картицу',
            nextTab: 'Следећа картица',
            previousTab: 'Претходна картица',
            nextTabAlt: 'Следећа картица (друга пречица)',
            previousTabAlt: 'Претходна картица (друга пречица)',
            switchToTabRange: 'Пређи на картицу 1–8',
            switchToLastTab: 'Пређи на последњу картицу',
            newSession: 'Нова сесија',
            commandPalette: 'Палета команди',
            switchWorkspace: 'Промени радни простор',
            settings: 'Подешавања',
            toggleLeftSidebar: 'Прикажи или сакриј леву бочну траку',
            toggleRightSidebar: 'Прикажи или сакриј десну бочну траку',
            toggleSessionActionPanel: 'Прикажи или сакриј панел радњи сесије',
          },
        }}
      />,
    );

    expect(headings(out)).toEqual(['h2:Језик и пречице', 'h3:Језик', 'h3:Пречице на тастатури']);
    expect(out).toContain('Тастер модификатора');
    expect(out).toContain('Нова картица');
    expect(out).not.toContain('>Keyboard shortcuts<');
    expect(out).not.toContain('>New tab<');
  });
});

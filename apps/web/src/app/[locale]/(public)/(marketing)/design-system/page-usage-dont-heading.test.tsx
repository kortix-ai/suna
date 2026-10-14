import { expect, test } from 'bun:test';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { NextIntlClientProvider, type AbstractIntlMessages } from '@/i18n/use-translations';
import de from '../../../../../../translations/de.json';
import en from '../../../../../../translations/en.json';
import es from '../../../../../../translations/es.json';
import fr from '../../../../../../translations/fr.json';
import it from '../../../../../../translations/it.json';
import ja from '../../../../../../translations/ja.json';
import pt from '../../../../../../translations/pt.json';
import sr from '../../../../../../translations/sr.json';
import zh from '../../../../../../translations/zh.json';

import DesignSystemPage from './page';
import type { MessageTree } from '@/i18n/client-catalog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The English apostrophe suffix (KRTX-2281), as a render contract: the usage
 * section's "Don't" heading appended `{"'"}t` in JSX after the catalog value,
 * so every non-English locale rendered broken copy ("No hagas't", "Nicht't").
 * The suffix is English syntax, not translation. The catalog value is now the
 * complete clause per locale (en "Don't") and the JSX renders it alone.
 *
 * The usage section is closed by default, so the test opens it the way a
 * visitor does: the `#usage` deep link (the page's followHash effect).
 */

const LOCALES = ['en', 'es', 'de', 'fr', 'it', 'ja', 'pt', 'sr', 'zh'] as const;
type CatalogLocale = (typeof LOCALES)[number];

const EXPECTED_DONT_HEADINGS: Record<CatalogLocale, string> = {
  en: "Don't",
  es: 'No hagas',
  de: 'Nicht',
  fr: 'Ne pas',
  it: 'Non fare',
  ja: '禁止事項',
  pt: 'Não',
  sr: 'Не',
  zh: '不要',
};

const CATALOGS: Record<CatalogLocale, MessageTree> = {
  en,
  es,
  de,
  fr,
  it,
  ja,
  pt,
  sr,
  zh,
};

Object.defineProperty(globalThis, 'window', {
  value: {
    location: { origin: 'http://localhost', protocol: 'https:', hash: '#usage' },
    addEventListener: () => {},
    removeEventListener: () => {},
    scrollY: 0,
    setTimeout,
    clearTimeout,
  },
  configurable: true,
});
Object.defineProperty(globalThis, 'document', {
  configurable: true,
  value: { getElementById: () => null },
});
Object.defineProperty(globalThis, 'requestAnimationFrame', {
  value: (callback: (time: number) => void) => setTimeout(() => callback(0), 0),
  configurable: true,
});
Object.defineProperty(globalThis, 'cancelAnimationFrame', {
  value: (id: number) => clearTimeout(id),
  configurable: true,
});

function paragraphText(node: ReactTestInstance): string {
  return node.children.map((child) => (typeof child === 'string' ? child : '')).join('');
}

test.each([...LOCALES])(
  "design-system usage 'Don't' heading renders the complete %s clause",
  async (locale) => {
    const expected = EXPECTED_DONT_HEADINGS[locale];
    const rendered: ReactTestRenderer[] = [];
    try {
      await act(async () => {
        rendered.push(
          create(
            <NextIntlClientProvider
              locale={locale}
              messages={CATALOGS[locale] as AbstractIntlMessages}
            >
              <DesignSystemPage />
            </NextIntlClientProvider>,
          ),
        );
      });
      const root = rendered[0];
      if (!root) throw new Error('Design-system page did not render');
      // Scope to the usage section: "Don't" also appears verbatim elsewhere on
      // the page (line566JsxTextDonAposT), so the page-level match is not unique.
      const usage = root.root.find((node) => node.props.id === 'usage');
      const headings = usage.findAll(
        (node) => node.type === 'p' && paragraphText(node) === expected,
      );
      expect(headings).toHaveLength(1);
      expect(paragraphText(headings[0]!)).toBe(expected);
    } finally {
      for (const r of rendered) await act(async () => r.unmount());
    }
  },
);
